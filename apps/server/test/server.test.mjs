import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSecret } from '../src/admin-input.mjs';
import { makePdf, makeDocx } from './document-fixtures.mjs';
import { createApp } from '../src/app.mjs';
import WebSocket from 'ws';
import { extractKnowledge, selectSources } from '../src/knowledge.mjs';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');

test('administrator screenshot defaults are inherited and queued models retain snapshots', async t => {
  const calls=[];const s=await setup(t,{runner:async input=>{calls.push(input);return {answer:'ok'};}});
  const a=await s.login(),b=await s.login('other@example.com');
  const prefs={screenshot:{provider:'claude',models:{codex:'high-quality-codex',claude:'qwen-max'}}};
  const save=await s.api('/model-preferences',a,'PUT',{preferences:prefs});assert.equal(save.status,200);assert.deepEqual((await save.json()).preferences,prefs);
  assert.equal((await (await s.api('/model-preferences',b)).json()).preferences.screenshot.models.claude,'qwen-max');
  assert.equal((await s.api('/model-preferences',b,'PUT',{preferences:prefs})).status,403);
  const bad=await s.api('/model-preferences',a,'PUT',{preferences:{screenshot:{models:{claude:'--inject config'}}}});assert.equal(bad.status,400);
  const form=new FormData();form.set('captureId',randomUUID());form.set('image',new Blob([pixel],{type:'image/png'}),'test.png');
  const upload=await s.api('/captures',a,'POST',form);assert.equal(upload.status,201);const {task}=await upload.json();assert.equal(task.provider,'claude');assert.equal(task.model,'qwen-max');
  await s.api('/model-preferences',a,'PUT',{preferences:{screenshot:{models:{claude:'qwen-flash'}}}});
  await s.worker.tick();await s.worker.idle();assert.equal(calls[0].model,'qwen-max');assert.equal(calls[0].provider,'claude');
});
async function setup(t, opts = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dual-link-test-'));
  const svc = await createApp({ dataDir, secureCookies: false, startWorker: false, ...opts });
  await new Promise(r => svc.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${svc.server.address().port}`;
  t.after(async () => { await svc.close(); await rm(dataDir, { recursive: true, force: true }); });
  const admin = svc.createUser({ email: 'admin@example.com', name: '管理员', password: 'correct-password-123', role: 'admin' });
  svc.createUser({ email: 'other@example.com', name: '其他用户', password: 'correct-password-123' });
  async function login(email = 'admin@example.com') {
    const r = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-password-123' }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return { ...body, headers: { cookie, 'X-CSRF-Token': body.csrfToken } };
  }
  async function api(route, auth, method = 'GET', body) {
    const multipart = body instanceof FormData;
    return fetch(url + '/api' + route, { method, headers: { ...auth?.headers, ...(!multipart && body ? { 'content-type': 'application/json' } : {}) }, body: body ? (multipart ? body : JSON.stringify(body)) : undefined });
  }
  return { ...svc, dataDir, url, api, login, admin };
}

test('sessions require CSRF, reject incorrect password and isolate prompt ownership', async t => {
  const { api, login } = await setup(t);
  const a = await login();
  const b = await login('other@example.com');
  assert.equal((await api('/auth/me')).status, 401);
  assert.equal((await api('/auth/login', null, 'POST', { email: 'admin@example.com', password: 'wrong' })).status, 401);
  assert.equal((await api('/prompts', { headers: { cookie: a.headers.cookie } }, 'POST', { name: 'bad', content: 'bad' })).status, 403);
  const create = await api('/prompts', a, 'POST', { name: '测试风格', content: '先结论后解释', isDefault: true });
  assert.equal(create.status, 201);
  const { prompt } = await create.json();
  assert.equal((await api(`/prompts/${prompt.id}`, b, 'PUT', { name: '偷改', content: 'x' })).status, 404);
  assert.equal((await api(`/prompts/${prompt.id}`, b, 'DELETE')).status, 404);
  assert.equal((await api('/prompts', a)).status, 200);
});

test('numeric proxy settings keep login rate limits separate for real clients behind Caddy', async t => {
  const { url } = await setup(t, { trustProxy: '1' });
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.10' }, body: JSON.stringify({ email: 'admin@example.com', password: 'incorrect-password' }) });
    assert.equal(result.status, 401);
    await result.arrayBuffer();
  }
  const otherClient = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20' }, body: JSON.stringify({ email: 'admin@example.com', password: 'correct-password-123' }) });
  assert.equal(otherClient.status, 200, 'one client must not exhaust all users login allowance');
});

test('pairing is single-use, device token is hashed and revocation is immediate', async t => {
  const { api, login, db } = await setup(t);
  const a = await login();
  const secret = randomBytes(32).toString('hex');
  const start = await api('/pairings', null, 'POST', { name: 'Windows PC', deviceSecret: secret });
  assert.equal(start.status, 201);
  const pair = await start.json();
  const wrong = { headers: { authorization: 'Bearer wrong' } };
  assert.equal((await api(`/pairings/${pair.id}`, wrong)).status, 401);
  const approved = await api('/pairings/approve', a, 'POST', { code: pair.code });
  const { device } = await approved.json();
  assert.equal(approved.status, 200);
  assert.equal((await api('/pairings/approve', a, 'POST', { code: pair.code })).status, 409);
  const pc = { headers: { authorization: `Bearer ${secret}` } };
  assert.equal((await api('/device/me', pc)).status, 200);
  assert.notEqual(db.prepare('SELECT token_hash FROM devices WHERE id=?').get(device.id).token_hash, secret);
  await api(`/devices/${device.id}`, a, 'DELETE');
  assert.equal((await api('/device/me', pc)).status, 401);
});

test('capture upload deduplicates and enforces ownership; manual review creates no task', async t => {
  const { api, login } = await setup(t);
  const a = await login(); const b = await login('other@example.com');
  const id = randomUUID();
  function form() { const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 'shot.png'); f.set('captureId', id); f.set('analyze', 'false'); return f; }
  const first = await api('/captures', a, 'POST', form());
  assert.equal(first.status, 201);
  const body = await first.json(); assert.equal(body.task, null);
  const dup = await (await api('/captures', a, 'POST', form())).json();
  assert.equal(dup.capture.id, body.capture.id);
  assert.equal((await api(`/captures/${body.capture.id}/image`, b)).status, 404);
  assert.equal((await api(`/captures/${body.capture.id}/analyze`, b, 'POST', {})).status, 404);
  assert.equal((await (await api('/tasks', a)).json()).tasks.length, 0);
});

test('knowledge and prompt are snapshotted; worker persists final answer and handles quota', async t => {
  const calls = [];
  const svc = await setup(t, { runner: async input => { calls.push(input); input.onDelta?.('你好'); return { answer: '最终回答', usage: { input_tokens: 10 } }; } });
  const { api, login, worker } = svc; const a = await login();
  const k = new FormData(); k.set('file', new Blob(['项目火星使用 SQLite 存储并通过 WebSocket 传输'], { type: 'text/plain' }), '项目.txt');
  assert.equal((await api('/knowledge', a, 'POST', k)).status, 201);
  const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 'shot.png'); f.set('captureId', randomUUID()); f.set('question', '项目火星采用什么存储？');
  const { task } = await (await api('/captures', a, 'POST', f)).json();
  await worker.tick(); await worker.idle();
  const done = await (await api(`/tasks/${task.id}`, a)).json();
  assert.equal(done.task.status, 'completed'); assert.equal(done.task.answer, '最终回答');
  assert.match(calls[0].prompt, /项目火星/); assert.match(calls[0].prompt, /项目.txt/);
  assert.equal(done.task.sources[0].name, '项目.txt');
  await api(`/admin/users/${a.user.id}`, a, 'PATCH', { dailyLimit: 1 });
  assert.equal((await api(`/captures/${done.task.captureId}/analyze`, a, 'POST', {})).status, 429);
});

test('disabled users lose browser sessions and device access', async t => {
  const { api, login } = await setup(t);
  const admin = await login(); const user = await login('other@example.com');
  assert.equal((await api(`/admin/users/${admin.user.id}`, admin, 'PATCH', { disabled: true })).status, 400);
  assert.equal((await api(`/admin/users/${user.user.id}`, admin, 'PATCH', { disabled: true })).status, 200);
  assert.equal((await api('/auth/me', user)).status, 401);
});

test('WebSocket tickets are one-use, and signaling only reaches opposite peers of the owner', async t => {
  const { api, login, url } = await setup(t);
  const a = await login(); const b = await login('other@example.com');
  const secret = randomBytes(32).toString('hex');
  const pairing = await (await api('/pairings', null, 'POST', { name: '信令测试PC', deviceSecret: secret })).json();
  await api('/pairings/approve', a, 'POST', { code: pairing.code });
  const pc = { headers: { authorization: `Bearer ${secret}` } };
  async function connect(auth, kind) {
    const { ticket } = await (await api('/ws-ticket', auth, 'POST', { kind })).json();
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws?ticket=' + ticket);
    const events = [];
    const hello = await new Promise((resolve, reject) => { ws.on('message', raw => { const event = JSON.parse(raw); events.push(event); if (event.type === 'hello') resolve(event); }); ws.on('error', reject); });
    t.after(() => ws.terminate()); return { ws, hello, events, ticket };
  }
  const web = await connect(a, 'web'); const foreign = await connect(b, 'web'); const desktop = await connect(pc, 'desktop');
  desktop.ws.send(JSON.stringify({ type: 'signal', targetPeerId: web.hello.peerId, payload: { kind: 'offer', sdp: 'owned-offer' } }));
  await new Promise(r => setTimeout(r, 30));
  assert.ok(web.events.some(e => e.type === 'signal' && e.payload.sdp === 'owned-offer'));
  desktop.ws.send(JSON.stringify({ type: 'signal', targetPeerId: foreign.hello.peerId, payload: { kind: 'offer', sdp: 'foreign-offer' } }));
  await new Promise(r => setTimeout(r, 30));
  assert.ok(!foreign.events.some(e => e.type === 'signal'));
  const replay = new WebSocket(url.replace('http:', 'ws:') + '/ws?ticket=' + web.ticket);
  await new Promise(resolve => { replay.once('error', resolve); replay.once('open', () => assert.fail('Consumed ticket was accepted')); });
});

test('worker recovers stale persisted work and cancellation is preserved', async t => {
  const { api, login, db, worker } = await setup(t, { runner: async ({ signal }) => { await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 100); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true }); }); return { answer: '恢复成功' }; } });
  const a = await login();
  function form() { const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 's.png'); f.set('captureId', randomUUID()); return f; }
  const first = await (await api('/captures', a, 'POST', form())).json();
  db.prepare("UPDATE tasks SET status='running',lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(first.task.id);
  await worker.tick(); await worker.idle();
  assert.equal((await (await api(`/tasks/${first.task.id}`, a)).json()).task.status, 'completed');
  const second = await (await api('/captures', a, 'POST', form())).json();
  await worker.tick();
  await api(`/tasks/${second.task.id}/cancel`, a, 'POST', {});
  await worker.idle();
  assert.equal((await (await api(`/tasks/${second.task.id}`, a)).json()).task.status, 'cancelled');
  const retry = await api(`/tasks/${second.task.id}/retry`, a, 'POST', {}); assert.equal(retry.status, 201);
  await worker.tick(); await worker.idle();
  assert.equal((await (await api(`/tasks/${second.task.id}`, a)).json()).task.status, 'completed');
});

test('untrusted knowledge rejects oversized DOCX decompression before parsing', async () => {
  const archive = Buffer.alloc(46 + 22); archive.writeUInt32LE(0x02014b50, 0); archive.writeUInt32LE(100 * 1024 * 1024, 24); archive.writeUInt32LE(0x06054b50, 46); archive.writeUInt16LE(1, 54); archive.writeUInt16LE(1, 56); archive.writeUInt32LE(46, 58); archive.writeUInt32LE(0, 62);
  await assert.rejects(() => extractKnowledge(archive, 'bomb.docx'), /解压|DOCX/);
  const sources = selectSources([{ name: '中文.md', text: '双端互联采用SQLite数据库，WebSocket负责长连接。' }], 'SQLite');
  assert.equal(sources[0].name, '中文.md');
});

test('concurrent uploads use one capture and one initial job', async t => {
  const { api, login } = await setup(t); const a = await login(); const key = randomUUID();
  function form() { const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 's.png'); f.set('captureId', key); return f; }
  const responses = await Promise.all([api('/captures', a, 'POST', form()), api('/captures', a, 'POST', form()), api('/captures', a, 'POST', form())]);
  const bodies = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(bodies.map(b => b.capture.id)).size, 1); assert.equal(new Set(bodies.map(b => b.task.id)).size, 1);
  assert.equal((await (await api('/tasks', a)).json()).tasks.length, 1);
});

test('worker shutdown requeues immediately; retries wait for cancelled execution to settle', async t => {
  let sequence = 0;
  const runner = async ({ signal }) => {
    const nth = ++sequence;
    if (nth === 1) { await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => setTimeout(resolve, 50), { once: true }); }); return { answer: '旧回答不应覆盖重试' }; }
    return { answer: '新回答' };
  };
  const { api, login, worker, db } = await setup(t, { runner, concurrency: 2 }); const a = await login();
  const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 's.png'); f.set('captureId', randomUUID());
  const { task } = await (await api('/captures', a, 'POST', f)).json(); await worker.tick();
  while (!sequence) await new Promise(r => setTimeout(r, 5));
  await api(`/tasks/${task.id}/cancel`, a, 'POST', {});
  const retryPromise = api(`/tasks/${task.id}/retry`, a, 'POST', {}); await worker.tick();
  assert.equal((await retryPromise).status, 201); await worker.tick(); await worker.idle();
  assert.equal((await (await api(`/tasks/${task.id}`, a)).json()).task.answer, '新回答');
  // Requeue a new running task on clean shutdown, rather than leaving a long stale lease.
  db.prepare("UPDATE tasks SET status='queued',answer='' WHERE id=?").run(task.id);
  sequence = 0; await worker.tick(); while (!sequence) await new Promise(r => setTimeout(r, 5));
  await worker.close(); assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status, 'queued');
});

test('timeouts fail with a distinct message and no leaked model stderr', async t => {
  const runner = async ({ signal }) => { await new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); };
  const { api, login, worker } = await setup(t, { runner, timeoutMs: 40 }); const a = await login();
  const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 's.png'); f.set('captureId', randomUUID());
  const { task } = await (await api('/captures', a, 'POST', f)).json(); await worker.tick(); await worker.idle();
  const final = (await (await api(`/tasks/${task.id}`, a)).json()).task;
  assert.equal(final.status, 'failed'); assert.match(final.error, /超时/);
});

test('hidden administrator password input never echoes secret and restores terminal mode', async () => {
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false; input.setRawMode = mode => { input.isRaw = mode; };
  let rendered = ''; const output = { write: chunk => { rendered += chunk; } };
  const pending = readSecret('Password: ', input, output); input.write('secret-value\r');
  assert.equal(await pending, 'secret-value'); assert.equal(rendered, 'Password: \n'); assert.equal(input.isRaw, false);
});

test('administrator CLI can create and recover credentials without exposing passwords', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dual-admin-test-')); let svc; t.after(async () => { await svc?.close(); await rm(dir, { recursive: true, force: true }); });
  const script = fileURLToPath(new URL('../src/admin.mjs', import.meta.url));
  const env = { ...process.env, DATA_DIR: dir, DUALLINK_ADMIN_PASSWORD: '' };
  const first = spawnSync(process.execPath, [script, '--email', 'recover@example.com'], { env, input: 'first-password-123\n', encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr); assert.ok(!first.stdout.includes('first-password'));
  const reset = spawnSync(process.execPath, [script, '--email', 'recover@example.com', '--reset-password'], { env, input: 'second-password-123\n', encoding: 'utf8' });
  assert.equal(reset.status, 0, reset.stderr); assert.match(reset.stdout, /Reset password/);
  svc = await createApp({ dataDir: dir, startWorker: false, runner: async () => ({ answer: 'unused' }) });
  await new Promise(r => svc.server.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${svc.server.address().port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'recover@example.com', password: 'second-password-123' }) });
  assert.equal(r.status, 200);
});

test('large knowledge first extracts screenshot keywords, preserves snapshots and exposes the stage', async t => {
  const calls = [];
  const { api, login, worker } = await setup(t, { runner: async input => { calls.push(input); if (calls.length === 1) return { answer: '稀有关键词Omega' }; return { answer: '依据稀有资料回答' }; } });
  const a = await login();
  const { prompts } = await (await api('/prompts', a)).json();
  await api(`/prompts/${prompts[0].id}`, a, 'PUT', { name: '快照风格', content: '只用提交时的固定风格', isDefault: true });
  async function knowledge(name, text) { const f = new FormData(); f.set('file', new Blob([text], { type: 'text/plain' }), name); await api('/knowledge', a, 'POST', f); }
  await knowledge('大量背景.txt', '普通背景信息与项目说明。'.repeat(1800));
  await knowledge('稀有资料.txt', '稀有关键词Omega对应的答案是蓝色数据库。');
  const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 's.png'); f.set('captureId', randomUUID());
  const { task } = await (await api('/captures', a, 'POST', f)).json();
  await api(`/prompts/${prompts[0].id}`, a, 'PUT', { name: '新风格', content: '后续修改不可污染已提交任务', isDefault: true });
  await knowledge('后来新增.txt', '后加入资料不得进入已提交任务');
  await worker.tick(); await worker.idle();
  const completed = (await (await api(`/tasks/${task.id}`, a)).json()).task;
  assert.equal(calls.length, 2); assert.match(calls[0].prompt, /提取/);
  assert.match(calls[1].prompt, /稀有关键词Omega/); assert.match(calls[1].prompt, /只用提交时的固定风格/);
  assert.ok(!calls[1].prompt.includes('后加入资料不得进入已提交任务'));
  assert.equal(completed.stage, 'completed'); assert.equal(completed.sources[0].name, '稀有资料.txt');
});

test('real PDF and DOCX knowledge parsing extracts text; blank PDF asks for OCR', async () => {
  assert.match(await extractKnowledge(makePdf('Hello PDF Knowledge'), 'reference.pdf'), /Hello PDF Knowledge/);
  assert.match(await extractKnowledge(makeDocx('知识库中文 DOCX'), 'reference.docx'), /知识库中文 DOCX/);
  await assert.rejects(() => extractKnowledge(makePdf(), 'scan.pdf'), /没有提取到文字|OCR/);
});

test('large knowledge extraction failures expose a bounded fallback warning', async t => {
  let calls = 0;
  const { api, login, worker } = await setup(t, { runner: async () => { if (++calls === 1) throw new Error('private credential stderr must not leak'); return { answer: '降级后的回答' }; } }); const a = await login();
  const k = new FormData(); k.set('file', new Blob(['资料内容'.repeat(5000)], { type: 'text/plain' }), '背景.txt'); await api('/knowledge', a, 'POST', k);
  const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 's.png'); f.set('captureId', randomUUID());
  const { task } = await (await api('/captures', a, 'POST', f)).json(); await worker.tick(); await worker.idle();
  const final = (await (await api(`/tasks/${task.id}`, a)).json()).task;
  assert.equal(final.status, 'completed'); assert.match(final.retrievalWarning, /关键词提取失败/); assert.ok(!JSON.stringify(final).includes('private credential'));
});

test('account manual-review preference is enforced for PC cloud uploads and explicit analyze still works', async t => {
  const { api, login } = await setup(t); const a = await login();
  const settings = await api('/settings', a, 'PUT', { autoAnalyze: false }); assert.equal(settings.status, 200);
  assert.equal((await (await api('/config', a)).json()).autoAnalyze, false);
  const secret = randomBytes(32).toString('hex'); const pc = { headers: { authorization: `Bearer ${secret}` } };
  const pair = await (await api('/pairings', null, 'POST', { name: 'Manual PC', deviceSecret: secret })).json(); await api('/pairings/approve', a, 'POST', { code: pair.code });
  assert.equal((await (await api('/device/me', pc)).json()).settings.autoAnalyze, false);
  const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 's.png'); f.set('captureId', randomUUID()); f.set('analyze', 'true');
  const response = await api('/captures', pc, 'POST', f); const { capture, task } = await response.json(); assert.equal(response.status, 201); assert.equal(task, null);
  assert.equal((await api(`/captures/${capture.id}/analyze`, a, 'POST', {})).status, 201);
});

test('administrator diagnostics checks real versions without returning credentials', async t => {
  const { api, login } = await setup(t, { cli: { codexBin: process.execPath, claudeBin: path.join(tmpdir(), 'no-such-model-command') } });
  const a = await login(); const b = await login('other@example.com');
  assert.equal((await api('/admin/diagnostics', b)).status, 403);
  const response = await api('/admin/diagnostics', a); const diagnostics = await response.json();
  assert.equal(response.status, 200); assert.equal(diagnostics.providers.codex.available, true); assert.equal(diagnostics.providers.claude.available, false);
  assert.match(diagnostics.providers.codex.version, /^\d+\.\d+\.\d+/); assert.ok(!JSON.stringify(diagnostics).includes(process.execPath));
});

test('provider failure codes produce actionable messages and never expose arbitrary stderr', async t => {
  const { api, login, worker } = await setup(t, { runner: async () => { throw Object.assign(new Error('secret-token:abcdef'), { code: 'AI_CLI_NOT_FOUND' }); } }); const a = await login();
  const f = new FormData(); f.set('image', new Blob([pixel], { type: 'image/png' }), 's.png'); f.set('captureId', randomUUID());
  const { task } = await (await api('/captures', a, 'POST', f)).json(); await worker.tick(); await worker.idle();
  const done = (await (await api(`/tasks/${task.id}`, a)).json()).task;
  assert.equal(done.status, 'failed'); assert.match(done.error, /绝对路径/); assert.ok(!JSON.stringify(done).includes('secret-token'));
});

test('logout terminates its WebSocket and invalidates outstanding tickets', async t => {
  const { api, login, url } = await setup(t); const a = await login();
  const { ticket } = await (await api('/ws-ticket', a, 'POST', { kind: 'web' })).json();
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws?ticket=' + ticket); t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.on('message', bytes => { if (JSON.parse(bytes).type === 'hello') resolve(); }); ws.on('error', reject); });
  const closed = new Promise(resolve => ws.once('close', resolve));
  await api('/auth/logout', a, 'POST', {}); await closed;
  assert.equal((await api('/auth/me', a)).status, 401);
});

test('only browser administrators can save shared AI profiles; secrets remain encrypted, masked and persistent', async t => {
  const {createAiSettings}=await import('../src/ai-settings.mjs');
  const {readFile,stat}=await import('node:fs/promises');
  const s=await setup(t),admin=await s.login(),member=await s.login('other@example.com');
  assert.equal((await s.api('/account/ai')).status,401);
  assert.equal((await s.api('/account/ai',member)).status,403);
  assert.equal((await s.api('/account/ai',member,'PUT',{profiles:{}})).status,403);
  assert.equal((await s.api('/account/ai',{headers:{cookie:admin.headers.cookie}},'PUT',{profiles:{}})).status,403);
  const secret='fixture-api-token-private';
  const saved=await s.api('/account/ai',admin,'PUT',{profiles:{
    'screenshot.claude':{authType:'bearer',model:'vision-model',apiKey:secret,baseUrl:'https://vision.example.test/anthropic'},
    'transcript.claude':{authType:'bearer',model:'fast-model',apiKey:'fixture-text-token',baseUrl:'https://text.example.test/anthropic'},
    'transcript.bailian':{model:'bailian-fast',apiKey:'fixture-bailian-token',workspaceId:'workspace-1',region:'cn-beijing'},
    asr:{model:'asr-model',apiKey:'fixture-asr-token',workspaceId:'workspace-2',region:'cn-beijing'},
    omni:{model:'audio-model',apiKey:'fixture-omni-token',workspaceId:'workspace-3',region:'cn-shanghai'}
  },defaults:{screenshotProvider:'claude',textProvider:'bailian'}});
  assert.equal(saved.status,200);
  const body=await saved.json();assert.equal(body.profiles['screenshot.claude'].hasApiKey,true);assert.equal(body.profiles['screenshot.claude'].apiKey,undefined);assert(!JSON.stringify(body).includes(secret));
  const stored=s.db.prepare('SELECT value FROM service_ai WHERE id=1').get().value;assert(!stored.includes(secret));assert(!Buffer.from(stored,'base64').toString().includes(secret));
  assert.equal((await stat(path.join(s.dataDir,'.ai-settings.key'))).mode&0o777,0o600);
  const runtime=createAiSettings({db:s.db,dataDir:s.dataDir});
  assert.equal(runtime.cli('screenshot','claude').extraEnv.ANTHROPIC_AUTH_TOKEN,secret);
  assert.equal(runtime.cli('transcript','claude').extraEnv.ANTHROPIC_AUTH_TOKEN,'fixture-text-token');
  runtime.save({'screenshot.codex':{apiKey:'fixture-codex-key',baseUrl:'https://codex.example.test/v1',model:'codex-model'}});
  assert.equal(runtime.cli('screenshot','codex').extraEnv.CODEX_API_KEY,'fixture-codex-key');
  assert.equal(runtime.api('asr').apiKey,'fixture-asr-token');assert.equal(runtime.api('omni').apiKey,'fixture-omni-token');
  assert.equal(runtime.api('transcript.bailian').textApiKey,'fixture-bailian-token');
  const inherited=await (await s.api('/config',member)).json();assert.equal(inherited.screenshotPreferences.provider,'claude');assert.equal(inherited.screenshotPreferences.models.claude,'vision-model');
  const defaults=await (await s.api('/interviews/preferences',member)).json();assert.equal(defaults.preferences.provider,'bailian');assert.equal(defaults.preferences.textModels.bailian,'bailian-fast');assert.equal(defaults.preferences.asrModel,'asr-model');assert.equal(defaults.preferences.audioModel,'audio-model');
  const config=await (await s.api('/interviews/config',member)).json();assert.equal(config.configured,true);assert.equal(config.audioConfigured,true);
  assert.equal((await s.api('/interviews/preferences',member,'PATCH',{provider:'codex'})).status,403);
  await s.api('/account/ai',admin,'PUT',{profiles:{'screenshot.claude':{model:'updated-vision'}}});
  assert.equal(runtime.cli('screenshot','claude').extraEnv.ANTHROPIC_AUTH_TOKEN,secret);
  const invalid=await s.api('/account/ai',admin,'PUT',{profiles:{'screenshot.claude':{apiKey:'replacement',baseUrl:'http://invalid.test'}}});assert.equal(invalid.status,400);assert.equal(runtime.cli('screenshot','claude').extraEnv.ANTHROPIC_AUTH_TOKEN,secret);
  runtime.save({'screenshot.claude':{authType:'api-key'}});assert.equal(runtime.cli('screenshot','claude').extraEnv.ANTHROPIC_API_KEY,secret);assert.equal(runtime.cli('screenshot','claude').extraEnv.ANTHROPIC_AUTH_TOKEN,'');
  await s.api('/account/ai',admin,'PUT',{profiles:{'screenshot.claude':{apiKey:''}}});assert.equal(runtime.view()['screenshot.claude'].hasApiKey,false);
  // No plaintext is persisted in the SQLite files either.
  assert(!(await readFile(path.join(s.dataDir,'dual-link.sqlite-wal'))).includes(Buffer.from(secret)));
});

test('member screenshot and interview requests cannot override administrator providers or models',async t=>{
  const calls=[];const s=await setup(t,{runner:async input=>{calls.push(input);return {answer:'OK'};}}),a=await s.login(),b=await s.login('other@example.com');
  await s.api('/account/ai',a,'PUT',{profiles:{'screenshot.claude':{model:'admin-vision'},'transcript.claude':{model:'admin-text'},asr:{model:'admin-asr'},omni:{model:'admin-audio'}},defaults:{screenshotProvider:'claude',textProvider:'claude'}});
  const form=new FormData();form.set('captureId',randomUUID());form.set('image',new Blob([pixel],{type:'image/png'}),'test.png');form.set('provider','codex');form.set('model','unapproved');
  const upload=await s.api('/captures',b,'POST',form);assert.equal(upload.status,201);const {task}=await upload.json();assert.equal(task.provider,'claude');assert.equal(task.model,'admin-vision');
  await s.worker.tick();await s.worker.idle();assert.equal(calls[0].provider,'claude');assert.equal(calls[0].model,'admin-vision');assert.equal(calls[0].userId,b.user.id);
  const created=await s.api('/interviews',b,'POST',{provider:'codex',textModels:{codex:'unapproved'},asrModel:'unapproved',audioModel:'unapproved'});assert.equal(created.status,201);const {interview}=await created.json();assert.equal(interview.provider,'claude');assert.equal(interview.textModels.claude,'admin-text');assert.equal(interview.asrModel,'admin-asr');assert.equal(interview.audioModel,'admin-audio');
  await s.api(`/interviews/${interview.id}/pause`,b,'POST',{});
  const patched=await s.api(`/interviews/${interview.id}`,b,'PATCH',{provider:'codex',textModels:{codex:'unapproved'}});assert.equal(patched.status,200);assert.equal((await patched.json()).interview.provider,'claude');
});

test('configured administrator Claude credentials reach the real screenshot CLI without mutating process environment',async t=>{
  const script='process.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"result",subtype:"success",result:JSON.stringify({token:process.env.ANTHROPIC_AUTH_TOKEN,base:process.env.ANTHROPIC_BASE_URL,model:process.argv[process.argv.indexOf("--model")+1]})}));});';
  const before=process.env.ANTHROPIC_AUTH_TOKEN;
  const s=await setup(t,{cli:{mode:'native',claudeBin:process.execPath,claudePrefixArgs:['-e',script,'--']}}),a=await s.login(),b=await s.login('other@example.com');
  const saved=await s.api('/account/ai',a,'PUT',{profiles:{'screenshot.claude':{authType:'bearer',apiKey:'fixture-vision-token',baseUrl:'https://fixture.example.test/anthropic',model:'fixture-vision-model'}},defaults:{screenshotProvider:'claude',textProvider:'codex'}});assert.equal(saved.status,200);
  const form=new FormData();form.set('captureId',randomUUID());form.set('image',new Blob([pixel],{type:'image/png'}),'fixture.png');
  const upload=await s.api('/captures',b,'POST',form);assert.equal(upload.status,201);const {task}=await upload.json();
  await s.worker.tick();await s.worker.idle();
  const row=s.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);assert.equal(row.status,'completed');assert.deepEqual(JSON.parse(row.answer),{token:'fixture-vision-token',base:'https://fixture.example.test/anthropic',model:'fixture-vision-model'});
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN,before);
  const secret=randomBytes(32).toString('hex');const pairing=await(await s.api('/pairings',null,'POST',{name:'Admin PC',deviceSecret:secret})).json();await s.api('/pairings/approve',a,'POST',{code:pairing.code});
  assert.equal((await s.api('/account/ai',{headers:{Authorization:'Bearer '+secret}})).status,403);
});
