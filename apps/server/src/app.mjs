import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.mjs';
import { now, hash, randomToken, fail, text, createUser, userView, passwordHash, verifyPassword } from './auth.mjs';
import { extractKnowledge, selectSources, buildPrompt } from './knowledge.mjs';
import { attachRealtime } from './realtime.mjs';
import { createWorker } from './worker.mjs';
import { diagnose } from './diagnostics.mjs';
import { createInterviewService } from './interviews.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const imageMax = 12 * 1024 * 1024;
const knowledgeMax = 10 * 1024 * 1024;
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const jsonParse = (str, fallback) => { try { return str ? JSON.parse(str) : fallback; } catch { return fallback; } };

export async function createApp(options = {}) {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const dataDir = path.resolve(projectRoot, options.dataDir || process.env.DATA_DIR || 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(dataDir);
  const app = express(); const server = createServer(app);
  const secureCookies = options.secureCookies ?? (process.env.SECURE_COOKIES !== undefined ? process.env.SECURE_COOKIES === 'true' : (options.publicOrigin || process.env.PUBLIC_ORIGIN || '').startsWith('http:') ? false : process.env.NODE_ENV === 'production');
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || '';
  const defaultProvider = options.defaultProvider || process.env.DEFAULT_PROVIDER || 'codex';
  const sessionDays = 14;
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/', maxAge: sessionDays * 86400000 };
  const proxySetting = options.trustProxy ?? process.env.TRUST_PROXY ?? 'loopback';
  const trustProxy = proxySetting === 'false' || proxySetting === '0' ? false : typeof proxySetting === 'string' && /^\d+$/.test(proxySetting) ? Number(proxySetting) : proxySetting;
  app.disable('x-powered-by'); app.set('trust proxy', trustProxy);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'", 'wss:', 'ws:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: secureCookies ? [] : null } }, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '64kb' })); app.use(cookieParser());
  app.use((req, res, next) => { if (req.body === undefined) req.body = {}; if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: '请求内容必须为 JSON 对象' }); next(); });
  app.use('/api', rateLimit({ windowMs: 60000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { error: '请求过于频繁，请稍后重试' } }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (bearer && bearer.length <= 256) {
      const device = db.prepare('SELECT d.*,u.disabled,u.email,u.role,u.daily_limit,u.name AS user_name FROM devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=?').get(hash(bearer));
      if (device && !device.disabled) { req.identity = { kind: 'device', userId: device.user_id, deviceId: device.id, device, role: device.role }; }
    } else if (req.cookies.dl_session && req.cookies.dl_session.length <= 256) {
      const row = db.prepare('SELECT s.*,u.disabled,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?').get(hash(req.cookies.dl_session));
      if (row && !row.disabled && row.expires_at > now()) req.identity = { kind: 'web', userId: row.user_id, csrf: row.csrf, tokenHash: row.token_hash, role: row.role };
    }
    next();
  });
  const requireAuth = (req, res, next) => { if (!req.identity) return next(Object.assign(new Error('请先登录或重新配对设备'), { status: 401 })); next(); };
  const browserOnly = (req, res, next) => { if (req.identity?.kind !== 'web') return next(Object.assign(new Error('请使用网站账号登录'), { status: 401 })); next(); };
  const csrf = (req, res, next) => {
    if (req.identity?.kind === 'web' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-CSRF-Token') !== req.identity.csrf) return next(Object.assign(new Error('安全校验失败，请刷新页面后重试'), { status: 403 }));
      if (publicOrigin && req.headers.origin && req.headers.origin !== publicOrigin) return next(Object.assign(new Error('请求来源不正确'), { status: 403 }));
    }
    next();
  };
  const protectedRouter = express.Router(); protectedRouter.use(requireAuth, csrf);
  const adminOnly = (req, res, next) => { if (req.identity?.kind !== 'web' || req.identity.role !== 'admin') return next(Object.assign(new Error('需要管理员权限'), { status: 403 })); next(); };
  const userRow = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const owned = (table, id, userId) => { const r = db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(id, userId); if (!r) fail(404, '记录不存在'); return r; };
  const promptView = p => ({ id: p.id, name: p.name, content: p.content, isDefault: !!p.is_default, version: p.version, createdAt: p.created_at, updatedAt: p.updated_at });
  const knowledgeView = k => ({ id: k.id, name: k.name, size: k.size, status: k.status, error: k.error, characters: k.text.length, createdAt: k.created_at });
  const taskView = t => ({ id: t.id, captureId: t.capture_id, provider: t.provider, status: t.status, stage: t.stage, answer: t.answer, error: t.error, retrievalWarning: t.retrieval_warning || null, question: t.question, promptName: t.prompt_name, createdAt: t.created_at, updatedAt: t.updated_at, sources: jsonParse(t.sources, []), usage: jsonParse(t.usage, undefined) });
  let realtime;
  const deviceView = d => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, online: realtime?.isOnline(d.id) || false });
  const devicesFor = userId => db.prepare('SELECT * FROM devices WHERE user_id=? ORDER BY created_at DESC').all(userId).map(deviceView);
  const captureView = c => ({ id: c.id, captureId: c.capture_key, deviceId: c.device_id, deviceName: c.device_id ? db.prepare('SELECT name FROM devices WHERE id=?').get(c.device_id)?.name : undefined, createdAt: c.created_at, imageUrl: `/api/captures/${c.id}/image` });
  realtime = attachRealtime({ server, db, publicOrigin, devicesFor });
  let runner = options.runner;
  if (!runner) { const { createCliRunner } = await import('./providers.mjs'); runner = createCliRunner(options.cli || {}); }
  const worker = createWorker({ db, dataDir, runner, publish: realtime.publish, taskView, concurrency: options.concurrency || Number(process.env.WORKER_CONCURRENCY) || 1, timeoutMs: options.timeoutMs || Number(process.env.AI_TIMEOUT_MS) || 180000, autoStart: options.startWorker !== false });
  const interviews = await createInterviewService({ server, db, dataDir, publicOrigin, publish: realtime.publish, textRunner: options.textRunner, audioRunner: options.audioRunner, omni: options.omni, cli: options.cli, asr: options.asr, asrFactory: options.asrFactory, options: options.interviews });
  protectedRouter.use('/interviews', interviews.router);

  app.get('/api/health', (req, res) => res.json({ ok: true, version: '1.2.0' }));
  const loginLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: '登录尝试过多，请 15 分钟后重试' } });
  app.post('/api/auth/login', loginLimit, asyncRoute(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    // Perform the same expensive operation even for an unknown account.
    const valid = verifyPassword(req.body.password, row?.password_hash || '00000000000000000000000000000000:' + '00'.repeat(64));
    if (!row || !valid || row.disabled) fail(401, '邮箱或密码不正确，或账号已停用');
    const token = randomToken(), csrfToken = randomToken();
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(hash(token), row.id, csrfToken, new Date(Date.now() + sessionDays * 86400000).toISOString());
    res.cookie('dl_session', token, cookieOptions).json({ user: userView(row), csrfToken });
  }));
  const pairLimit = rateLimit({ windowMs: 60000, limit: 15, standardHeaders: true, legacyHeaders: false, message: { error: '配对请求过多，请稍后重试' } });
  app.post('/api/pairings', pairLimit, asyncRoute(async (req, res) => {
    const name = text(req.body.name, '设备名称', 80), secret = text(req.body.deviceSecret, '设备密钥', 256);
    if (secret.length < 43 || !/^[A-Za-z0-9_\-+/=]+$/.test(secret)) fail(400, '设备密钥至少包含 32 字节随机数据');
    const id = randomUUID(); const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
    do { code = [...randomBytes(8)].map(n => alphabet[n % alphabet.length]).join(''); } while (db.prepare('SELECT id FROM pairings WHERE code=?').get(code));
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    db.prepare('DELETE FROM pairings WHERE expires_at<? AND approved=0').run(now());
    db.prepare('INSERT INTO pairings(id,code,name,secret_hash,expires_at) VALUES(?,?,?,?,?)').run(id, code, name, hash(secret), expiresAt);
    res.status(201).json({ id, code, expiresAt });
  }));
  app.get('/api/pairings/:id', asyncRoute(async (req, res) => {
    const token = req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    const row = db.prepare('SELECT * FROM pairings WHERE id=?').get(req.params.id);
    if (!row || !token || token.length > 256 || hash(token) !== row.secret_hash) fail(401, '配对凭据无效');
    if (row.approved) { const d = db.prepare('SELECT d.*,u.disabled FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=?').get(row.device_id); return res.json(d && !d.disabled ? { status: 'approved', device: deviceView(d) } : { status: 'expired' }); }
    res.json({ status: row.expires_at > now() ? 'pending' : 'expired' });
  }));

  protectedRouter.get('/auth/me', browserOnly, (req, res) => res.json({ user: userView(userRow(req.identity.userId)), csrfToken: req.identity.csrf }));
  protectedRouter.post('/auth/logout', browserOnly, (req, res) => { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.identity.tokenHash); realtime.revokeSession(req.identity.tokenHash); res.clearCookie('dl_session', { ...cookieOptions, maxAge: undefined }).json({ ok: true }); });
  protectedRouter.post('/auth/password', browserOnly, asyncRoute(async (req, res) => {
    const u = userRow(req.identity.userId); if (!verifyPassword(req.body.currentPassword, u.password_hash)) fail(400, '当前密码不正确');
    const encoded = passwordHash(req.body.newPassword);
    db.transaction(() => { db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(encoded, u.id); db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(u.id, req.identity.tokenHash); })();
    res.json({ ok: true });
  }));
  protectedRouter.get('/config', (req, res) => res.json({ providers: ['codex', 'claude'], defaultProvider, autoAnalyze: !!userRow(req.identity.userId).auto_analyze, iceServers: options.iceServers || (process.env.STUN_URL ? [{ urls: process.env.STUN_URL }] : []), maxUploadBytes: imageMax }));
  protectedRouter.put('/settings', browserOnly, (req, res) => {
    if (typeof req.body.autoAnalyze !== 'boolean') fail(400, 'autoAnalyze 必须为布尔值');
    db.prepare('UPDATE users SET auto_analyze=? WHERE id=?').run(req.body.autoAnalyze ? 1 : 0, req.identity.userId);
    res.json({ autoAnalyze: req.body.autoAnalyze });
  });
  protectedRouter.get('/device/me', (req, res) => {
    if (req.identity.kind !== 'device') return res.status(401).json({ error: '需要设备凭证' });
    const u = userRow(req.identity.userId); const p = db.prepare('SELECT id FROM prompts WHERE user_id=? AND is_default=1').get(u.id);
    res.json({ device: deviceView(req.identity.device), user: { id: u.id, name: u.name }, settings: { defaultProvider, defaultPromptId: p?.id || null, autoAnalyze: !!u.auto_analyze } });
  });
  protectedRouter.delete('/device/me', (req, res) => {
    if (req.identity.kind !== 'device') return res.status(401).json({ error: '需要设备凭证' });
    interviews.revokeDevice(req.identity.deviceId); realtime.revokeDevice(req.identity.deviceId); db.prepare('DELETE FROM devices WHERE id=?').run(req.identity.deviceId);
    realtime.deviceUpdate(req.identity.userId); res.json({ ok: true });
  });
  protectedRouter.post('/pairings/approve', browserOnly, pairLimit, asyncRoute(async (req, res) => {
    const code = text(req.body.code, '配对码', 20).replace(/[\s-]/g, '').toUpperCase();
    const device = db.transaction(() => {
      const pair = db.prepare('SELECT * FROM pairings WHERE code=?').get(code);
      if (!pair || pair.expires_at < now()) fail(404, '配对码不存在或已过期');
      if (pair.approved) fail(409, '配对码已使用');
      if (db.prepare('SELECT count(*) AS n FROM devices WHERE user_id=?').get(req.identity.userId).n >= 20) fail(400, '每个账号最多配对 20 台设备');
      const id = randomUUID(); const timestamp = now();
      db.prepare('INSERT INTO devices(id,user_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(id, req.identity.userId, pair.name, pair.secret_hash, timestamp, timestamp);
      db.prepare('UPDATE pairings SET approved=1,device_id=? WHERE id=?').run(id, pair.id);
      return db.prepare('SELECT * FROM devices WHERE id=?').get(id);
    })(); realtime.deviceUpdate(req.identity.userId); res.json({ device: deviceView(device) });
  }));
  protectedRouter.get('/devices', (req, res) => res.json({ devices: devicesFor(req.identity.userId) }));
  protectedRouter.delete('/devices/:id', browserOnly, (req, res) => {
    owned('devices', req.params.id, req.identity.userId); interviews.revokeDevice(req.params.id); realtime.revokeDevice(req.params.id);
    db.prepare('DELETE FROM devices WHERE id=?').run(req.params.id); realtime.deviceUpdate(req.identity.userId); res.json({ ok: true });
  });
  protectedRouter.post('/ws-ticket', (req, res) => {
    const kind = req.identity.kind === 'device' ? 'desktop' : 'web';
    if (req.body.kind && req.body.kind !== kind) fail(403, '连接类型与凭据不一致');
    const ticket = randomToken();
    db.prepare('INSERT INTO ws_tickets(token_hash,user_id,device_id,kind,expires_at,session_hash) VALUES(?,?,?,?,?,?)').run(hash(ticket), req.identity.userId, req.identity.deviceId || null, kind, new Date(Date.now() + 30000).toISOString(), req.identity.kind === 'web' ? req.identity.tokenHash : null);
    res.json({ ticket });
  });

  protectedRouter.get('/admin/users', adminOnly, (req, res) => res.json({ users: db.prepare('SELECT * FROM users ORDER BY created_at').all().map(userView) }));
  protectedRouter.get('/admin/diagnostics', adminOnly, asyncRoute(async (req, res) => res.json(await diagnose(options.cli || {}))));
  protectedRouter.post('/admin/users', adminOnly, (req, res) => res.status(201).json({ user: createUser(db, { ...req.body, role: 'user' }) }));
  protectedRouter.patch('/admin/users/:id', adminOnly, (req, res) => {
    const target = userRow(req.params.id); if (!target) fail(404, '用户不存在');
    const fields = {}; const body = req.body;
    if (body.name !== undefined) fields.name = text(body.name, '名称', 80);
    if (body.disabled !== undefined) { if (typeof body.disabled !== 'boolean') fail(400, '账号状态格式不正确'); if (body.disabled && (target.id === req.identity.userId || target.role === 'admin')) fail(400, '不能停用当前管理员或管理员账号'); fields.disabled = body.disabled ? 1 : 0; }
    if (body.dailyLimit !== undefined) { if (!Number.isInteger(body.dailyLimit) || body.dailyLimit < 0 || body.dailyLimit > 100000) fail(400, '每日额度格式不正确'); fields.daily_limit = body.dailyLimit; }
    if (body.password !== undefined) fields.password_hash = passwordHash(body.password);
    if (Object.keys(fields).length) db.prepare(`UPDATE users SET ${Object.keys(fields).map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(fields), target.id);
    if (fields.disabled || fields.password_hash) { db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); realtime.revokeUser(target.id); }
    if (fields.disabled) { interviews.revokeUser(target.id); for (const task of db.prepare("SELECT id FROM tasks WHERE user_id=? AND status IN ('queued','running')").all(target.id)) { db.prepare("UPDATE tasks SET status='cancelled',stage='cancelled',updated_at=? WHERE id=?").run(now(), task.id); worker.cancel(task.id); } }
    res.json({ user: userView(userRow(target.id)) });
  });

  protectedRouter.get('/prompts', (req, res) => res.json({ prompts: db.prepare('SELECT * FROM prompts WHERE user_id=? ORDER BY is_default DESC,created_at').all(req.identity.userId).map(promptView) }));
  function savePrompt(req, id) {
    const name = text(req.body.name, '提示词名称', 80); const content = text(req.body.content, '提示词内容', 32000);
    if (req.body.isDefault !== undefined && typeof req.body.isDefault !== 'boolean') fail(400, '默认配置格式不正确');
    const uid = req.identity.userId; const timestamp = now();
    db.transaction(() => {
      const current = id ? owned('prompts', id, uid) : null;
      const count = db.prepare('SELECT count(*) AS n FROM prompts WHERE user_id=?').get(uid).n;
      if (!id && count >= 50) fail(400, '最多保存 50 套提示词');
      const isDefault = req.body.isDefault || count === 0 || (current?.is_default && req.body.isDefault !== false);
      if (isDefault) db.prepare('UPDATE prompts SET is_default=0 WHERE user_id=?').run(uid);
      if (id) db.prepare('UPDATE prompts SET name=?,content=?,is_default=?,version=version+1,updated_at=? WHERE id=?').run(name, content, isDefault ? 1 : 0, timestamp, id);
      else { id = randomUUID(); db.prepare('INSERT INTO prompts(id,user_id,name,content,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, uid, name, content, isDefault ? 1 : 0, timestamp, timestamp); }
      if (!db.prepare('SELECT id FROM prompts WHERE user_id=? AND is_default=1').get(uid)) db.prepare('UPDATE prompts SET is_default=1 WHERE id=(SELECT id FROM prompts WHERE user_id=? ORDER BY created_at LIMIT 1)').run(uid);
    })();
    return promptView(owned('prompts', id, uid));
  }
  protectedRouter.post('/prompts', browserOnly, (req, res) => res.status(201).json({ prompt: savePrompt(req) }));
  protectedRouter.put('/prompts/:id', browserOnly, (req, res) => res.json({ prompt: savePrompt(req, req.params.id) }));
  protectedRouter.delete('/prompts/:id', browserOnly, (req, res) => {
    owned('prompts', req.params.id, req.identity.userId);
    db.transaction(() => { db.prepare('DELETE FROM prompts WHERE id=?').run(req.params.id); if (!db.prepare('SELECT id FROM prompts WHERE user_id=? AND is_default=1').get(req.identity.userId)) db.prepare('UPDATE prompts SET is_default=1 WHERE id=(SELECT id FROM prompts WHERE user_id=? ORDER BY created_at LIMIT 1)').run(req.identity.userId); })();
    res.json({ ok: true });
  });

  const uploadKnowledge = multer({ storage: multer.memoryStorage(), limits: { fileSize: knowledgeMax, files: 1, fields: 2 } }).single('file');
  protectedRouter.get('/knowledge', (req, res) => res.json({ files: db.prepare('SELECT * FROM knowledge WHERE user_id=? ORDER BY created_at DESC').all(req.identity.userId).map(knowledgeView) }));
  protectedRouter.post('/knowledge', browserOnly, uploadKnowledge, asyncRoute(async (req, res) => {
    if (!req.file) fail(400, '请选择知识库文件');
    const uid = req.identity.userId;
    const totals = db.prepare('SELECT count(*) AS n,COALESCE(sum(size),0) AS size FROM knowledge WHERE user_id=?').get(uid);
    if (totals.n >= 100 || totals.size + req.file.size > 100 * 1024 * 1024) fail(400, '知识库上限为 100 份文件、总计 100 MiB');
    // Multer decodes multipart filenames as latin1; reconstruct UTF-8 when possible.
    const rawName = req.file.originalname; let name = rawName;
    const converted = Buffer.from(rawName, 'latin1').toString('utf8'); if (!converted.includes('\uFFFD')) name = converted;
    name = path.basename(name.replace(/\\/g, '/')).slice(0, 200);
    if (!/\.(txt|md|pdf|docx)$/i.test(name)) fail(400, '支持 TXT、Markdown、PDF、DOCX 文件');
    const id = randomUUID(); const relative = path.join('users', uid, 'knowledge', id + path.extname(name).toLowerCase());
    await mkdir(path.dirname(path.join(dataDir, relative)), { recursive: true, mode: 0o700 });
    let extracted = '', error = null;
    try { extracted = await extractKnowledge(req.file.buffer, name); } catch (e) { error = e.status ? e.message : '文件解析失败，请检查文件是否损坏、加密或扫描件'; }
    await writeFile(path.join(dataDir, relative), req.file.buffer, { mode: 0o600 });
    db.prepare('INSERT INTO knowledge(id,user_id,name,path,size,status,text,error,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, uid, name, relative, req.file.size, error ? 'error' : 'ready', extracted, error, now());
    res.status(201).json({ file: knowledgeView(owned('knowledge', id, uid)) });
  }));
  protectedRouter.get('/knowledge/:id/download', browserOnly, (req, res) => { const file = owned('knowledge', req.params.id, req.identity.userId); res.download(path.join(dataDir, file.path), file.name); });
  protectedRouter.delete('/knowledge/:id', browserOnly, asyncRoute(async (req, res) => { const file = owned('knowledge', req.params.id, req.identity.userId); db.prepare('DELETE FROM knowledge WHERE id=?').run(file.id); await unlink(path.join(dataDir, file.path)).catch(() => {}); res.json({ ok: true }); }));

  function createTask(uid, captureId, input = {}, dedup = true) {
    return db.transaction(() => {
      if (dedup) { const active = db.prepare("SELECT * FROM tasks WHERE capture_id=? AND user_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(captureId, uid); if (active) return taskView(active); }
      const u = userRow(uid); const today = new Date().toISOString().slice(0, 10);
      if (db.prepare('SELECT count(*) AS n FROM quota_events WHERE user_id=? AND created_at>=?').get(uid, today).n >= u.daily_limit) fail(429, '已达到今日任务额度');
      if (db.prepare("SELECT count(*) AS n FROM tasks WHERE user_id=? AND status IN ('queued','running')").get(uid).n >= 5) fail(429, '待处理任务过多，请稍后再试');
      const provider = input.provider || defaultProvider; if (!['codex', 'claude'].includes(provider)) fail(400, '模型服务不受支持');
      let prompt = input.promptId ? owned('prompts', input.promptId, uid) : db.prepare('SELECT * FROM prompts WHERE user_id=? ORDER BY is_default DESC,created_at LIMIT 1').get(uid);
      if (!prompt) prompt = { name: '默认风格', content: '请用中文准确回答截图中的问题。' };
      const question = input.question === undefined ? '' : text(input.question, '补充问题', 8000, false);
      const files = db.prepare("SELECT id,name,text FROM knowledge WHERE user_id=? AND status='ready'").all(uid);
      const sources = selectSources(files, question);
      const id = randomUUID(), timestamp = now();
      db.prepare("INSERT INTO tasks(id,user_id,capture_id,provider,status,question,prompt_name,prompt_snapshot,sources,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?,?,?,?)").run(id, uid, captureId, provider, question, prompt.name, buildPrompt(prompt.content, question, sources), JSON.stringify(sources), timestamp, timestamp);
      db.prepare('UPDATE tasks SET style_snapshot=?,knowledge_ids=?,needs_retrieval=? WHERE id=?').run(prompt.content, JSON.stringify(files.map(f => f.id)), files.reduce((total, f) => total + f.text.length, 0) > 14000 ? 1 : 0, id);
      db.prepare('INSERT INTO quota_events(id,user_id,created_at) VALUES(?,?,?)').run(randomUUID(), uid, timestamp);
      return taskView(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
    })();
  }
  const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: imageMax, files: 1, fields: 10, fieldSize: 40000 } }).single('image');
  protectedRouter.post('/captures', uploadImage, asyncRoute(async (req, res) => {
    if (!req.file) fail(400, '请选择截图图片');
    const key = req.body.captureId; if (!UUID.test(key || '')) fail(400, 'captureId 必须是 UUID');
    const uid = req.identity.userId;
    const existing = db.prepare('SELECT * FROM captures WHERE user_id=? AND capture_key=?').get(uid, key);
    if (existing) { const task = db.prepare('SELECT * FROM tasks WHERE capture_id=? ORDER BY created_at LIMIT 1').get(existing.id); return res.json({ capture: captureView(existing), task: task ? taskView(task) : null }); }
    const storage = db.prepare('SELECT count(*) AS n FROM captures WHERE user_id=?').get(uid).n;
    if (storage >= 5000) fail(400, '截图数量已达上限，请先删除历史截图');
    let metadata; try { metadata = await sharp(req.file.buffer, { limitInputPixels: 40_000_000, failOn: 'error' }).metadata(); } catch { fail(400, '图片无效或像素过大'); }
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || metadata.pages > 1) fail(400, '只支持静态 PNG、JPEG、WebP 图片');
    const analyze = (req.body.analyze === undefined || req.body.analyze === 'true') && !!userRow(uid).auto_analyze;
    if (req.body.analyze !== undefined && !['true', 'false'].includes(req.body.analyze)) fail(400, 'analyze 必须为 true 或 false');
    let deviceId = req.identity.deviceId || req.body.deviceId || null; if (deviceId) owned('devices', deviceId, uid);
    const id = randomUUID(); const relative = path.join('users', uid, 'screenshots', `${id}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`);
    await mkdir(path.dirname(path.join(dataDir, relative)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(dataDir, relative), req.file.buffer, { mode: 0o600 });
    let task;
    try {
      db.transaction(() => {
        // A competing upload may have completed while validating the image.
        const race = db.prepare('SELECT * FROM captures WHERE user_id=? AND capture_key=?').get(uid, key);
        if (race) return;
        db.prepare('INSERT INTO captures(id,user_id,capture_key,device_id,path,mime,created_at) VALUES(?,?,?,?,?,?,?)').run(id, uid, key, deviceId, relative, `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}`, now());
        task = analyze ? createTask(uid, id, req.body, false) : null;
      })();
    } catch (e) { await unlink(path.join(dataDir, relative)).catch(() => {}); throw e; }
    const saved = db.prepare('SELECT * FROM captures WHERE user_id=? AND capture_key=?').get(uid, key);
    if (saved.id !== id) { await unlink(path.join(dataDir, relative)).catch(() => {}); const row = db.prepare('SELECT * FROM tasks WHERE capture_id=? ORDER BY created_at LIMIT 1').get(saved.id); return res.json({ capture: captureView(saved), task: row ? taskView(row) : null }); }
    const capture = captureView(saved); realtime.publish(uid, { type: 'capture.created', capture });
    if (task) realtime.publish(uid, { type: 'task.updated', task });
    res.status(201).json({ capture, task });
  }));
  const limit = req => Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  protectedRouter.get('/captures', (req, res) => res.json({ captures: db.prepare('SELECT * FROM captures WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(req.identity.userId, limit(req)).map(captureView) }));
  protectedRouter.get('/captures/:id/image', (req, res) => { const c = owned('captures', req.params.id, req.identity.userId); res.type(c.mime).sendFile(path.join(dataDir, c.path)); });
  protectedRouter.delete('/captures/:id', browserOnly, asyncRoute(async (req, res) => {
    const c = owned('captures', req.params.id, req.identity.userId);
    for (const t of db.prepare('SELECT id FROM tasks WHERE capture_id=?').all(c.id)) worker.cancel(t.id);
    db.prepare('DELETE FROM captures WHERE id=?').run(c.id); await unlink(path.join(dataDir, c.path)).catch(() => {}); res.json({ ok: true });
  }));
  protectedRouter.post('/captures/:id/analyze', (req, res) => { const c = owned('captures', req.params.id, req.identity.userId); const task = createTask(req.identity.userId, c.id, req.body); realtime.publish(req.identity.userId, { type: 'task.updated', task }); res.status(201).json({ task }); });
  protectedRouter.get('/tasks', (req, res) => res.json({ tasks: db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(req.identity.userId, limit(req)).map(taskView) }));
  protectedRouter.get('/tasks/:id', (req, res) => res.json({ task: taskView(owned('tasks', req.params.id, req.identity.userId)) }));
  protectedRouter.post('/tasks/:id/cancel', (req, res) => {
    const task = owned('tasks', req.params.id, req.identity.userId);
    if (['queued', 'running'].includes(task.status)) { db.prepare("UPDATE tasks SET status='cancelled',stage='cancelled',updated_at=?,lease_until=NULL WHERE id=?").run(now(), task.id); worker.cancel(task.id); }
    const view = taskView(owned('tasks', task.id, req.identity.userId)); realtime.publish(req.identity.userId, { type: 'task.updated', task: view }); res.json({ task: view });
  });
  protectedRouter.post('/tasks/:id/retry', asyncRoute(async (req, res) => {
    const task = owned('tasks', req.params.id, req.identity.userId);
    if (!['failed', 'cancelled'].includes(task.status)) fail(409, '只有失败或取消的任务可以重试');
    await worker.waitFor(task.id);
    // Retrying keeps the original prompt snapshot and sources.
    db.transaction(() => {
      const current = owned('tasks', task.id, req.identity.userId);
      if (!['failed', 'cancelled'].includes(current.status)) fail(409, '任务已重新提交');
      const u = userRow(req.identity.userId), today = now().slice(0, 10);
      if (db.prepare('SELECT count(*) AS n FROM quota_events WHERE user_id=? AND created_at>=?').get(u.id, today).n >= u.daily_limit) fail(429, '已达到今日任务额度');
      if (db.prepare("SELECT count(*) AS n FROM tasks WHERE user_id=? AND status IN ('queued','running')").get(u.id).n >= 5) fail(429, '待处理任务过多');
      db.prepare("UPDATE tasks SET status='queued',stage='queued',answer='',error=NULL,updated_at=?,lease_until=NULL,attempts=0 WHERE id=?").run(now(), task.id);
      db.prepare('INSERT INTO quota_events(id,user_id,created_at) VALUES(?,?,?)').run(randomUUID(), u.id, now());
    })();
    const view = taskView(owned('tasks', task.id, req.identity.userId)); realtime.publish(req.identity.userId, { type: 'task.updated', task: view }); res.status(201).json({ task: view });
  }));

  app.use('/api', protectedRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  const webDir = options.webDir || fileURLToPath(new URL('../../web/dist/', import.meta.url));
  app.use(express.static(webDir, { index: 'index.html', maxAge: '1h' }));
  app.get('/{*path}', asyncRoute(async (req, res) => { try { await stat(path.join(webDir, 'index.html')); res.set('Cache-Control', 'no-cache').sendFile(path.join(webDir, 'index.html')); } catch { res.status(503).type('text').send('网站尚未构建，请在项目根目录运行 npm run build'); } }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof multer.MulterError ? 400 : error.status || (error.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error('[api]', error.code || error.name, error.message?.slice(0, 200));
    const publicError=status<500||error.code==='ASR_NOT_CONFIGURED';
    res.status(status).json({ error: error instanceof multer.MulterError ? '上传文件过大或字段不正确' : publicError ? error.message : '服务器处理失败，请检查服务日志', ...(error.code && publicError ? { code: error.code } : {}) });
  });
  const cleanup = setInterval(() => { const timestamp = now(); db.prepare('DELETE FROM sessions WHERE expires_at<?').run(timestamp); db.prepare('DELETE FROM pairings WHERE expires_at<? AND (approved=0 OR expires_at<?)').run(timestamp, new Date(Date.now() - 86400000).toISOString()); db.prepare('DELETE FROM quota_events WHERE created_at<?').run(new Date(Date.now() - 7 * 86400000).toISOString()); }, 3600000); cleanup.unref();
  let closed = false;
  return { app, server, db, dataDir, worker, interviews, createUser: input => createUser(db, input), async close() { if (closed) return; closed = true; clearInterval(cleanup); await interviews.close(); await worker.close(); await realtime.close(); if (server.listening) { server.closeAllConnections(); await new Promise(r => server.close(r)); } db.close(); } };
}
