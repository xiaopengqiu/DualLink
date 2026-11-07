import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { hash, randomToken, now, fail, text } from './auth.mjs';
import { asrConfiguration, createDashScopeAsrFactory } from './asr.mjs';
import { attachInterviewAudio, downloadInterviewAudio } from './audio.mjs';
import { assembleInterviewContext, isQuestion } from './interview-context.mjs';

const parse = (value, fallback = []) => { try { return JSON.parse(value); } catch { return fallback; } };
const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const boundedNumber = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));

export async function createInterviewService({ server, db, dataDir, publicOrigin, publish, textRunner, cli = {}, asr = {}, asrFactory, options = {} }) {
  const asrConfig = asrConfiguration(asr);
  const configured = typeof asrFactory === 'function' || asrConfig.configured;
  const maxSessionMinutes = boundedNumber(options.maxSessionMinutes ?? process.env.ASR_MAX_SESSION_MINUTES, 120, 1, 240);
  const retentionDays = options.rawAudioRetentionDays ?? options.retentionDays ?? (process.env.AUDIO_RETENTION_DAYS !== undefined ? Math.max(0, Math.min(30, Number(process.env.AUDIO_RETENTION_DAYS) || 0)) : 7);
  const timeoutMs = boundedNumber(options.timeoutMs ?? process.env.INTERVIEW_AI_TIMEOUT_MS, 90000, 100, 300000);
  const debounceMs = boundedNumber(options.autoDebounceMs ?? options.debounceMs ?? process.env.INTERVIEW_AUTO_DEBOUNCE_MS, 800, 20, 3000);
  const contextBudget = boundedNumber(options.contextChars ?? process.env.INTERVIEW_CONTEXT_CHARS, 40000, 4000, 120000);
  const concurrency = boundedNumber(options.concurrency ?? process.env.INTERVIEW_WORKER_CONCURRENCY, 2, 1, 4);
  const defaultProvider = options.defaultProvider || process.env.INTERVIEW_DEFAULT_PROVIDER || 'codex';
  const validProviders = ['codex', 'claude', 'bailian'];
  if (!validProviders.includes(defaultProvider)) throw new Error('INTERVIEW_DEFAULT_PROVIDER must be codex, claude or bailian');
  let lazyRunner;
  if (!textRunner) {
    const { createTextRunner } = await import('./text-providers.mjs');
    lazyRunner = createTextRunner({ ...cli, timeoutMs, runtimeRoot: path.join(dataDir, 'jobs', 'warm') }); textRunner = lazyRunner;
  }
  const router = express.Router(), active = new Map(), auto = new Map();
  let closed = false, pumping = false;
  const own = (id, userId) => { const row = db.prepare('SELECT * FROM interviews WHERE id=? AND user_id=?').get(id, userId); if (!row) fail(404, '面试会话不存在'); return row; };
  const user = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const interviewView = row => ({ id: row.id, title: row.title, status: row.status, provider: row.provider, promptId: row.prompt_id, promptName: row.prompt_name, autoAnswer: !!row.auto_answer, deviceId: row.device_id, recordingStatus: row.recording_status, error: row.error || null, createdAt: row.created_at, endedAt: row.ended_at, updatedAt: row.updated_at });
  const segmentView = row => ({ id: row.id, sessionId: row.session_id, track: row.track, segmentId: row.segment_key, text: row.text, startMs: row.start_ms, endMs: row.end_ms, final: !!row.final, revision: row.revision, replay: !!row.replay, createdAt: row.created_at, updatedAt: row.updated_at });
  const questionView = row => ({ id: row.id, sessionId: row.session_id, text: row.text, segmentIds: parse(row.segment_ids), revision: row.revision, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
  const answerView = row => {
    const context=row.context_snapshot_id?db.prepare('SELECT id,sources,summary,segment_ids,watermark FROM interview_contexts WHERE id=? AND session_id=?').get(row.context_snapshot_id,row.session_id):null;
    return { id: row.id, sessionId: row.session_id, questionId: row.question_id, questionRevision: row.question_revision, provider: row.provider, status: row.status, text: row.text, error: row.error || null, contextSnapshotId: row.context_snapshot_id, usage: parse(row.usage, null), createdAt: row.created_at, updatedAt: row.updated_at,
      sources:context?parse(context.sources):[],contextSummary:context?{id:context.id,summary:context.summary,segmentIds:parse(context.segment_ids),watermark:context.watermark}:null };
  };
  const getSession = id => db.prepare('SELECT * FROM interviews WHERE id=?').get(id);
  const event = (sessionId, value) => { const row = getSession(sessionId); if (row) publish(row.user_id, { sessionId, ...value }); };
  const notifyInterview = id => { const row = getSession(id); if (row) event(id, { type: 'interview.updated', interview: interviewView(row) }); };
  const notifyAnswer = id => { const row = db.prepare('SELECT * FROM interview_answers WHERE id=?').get(id); if (row) event(row.session_id, { type: 'interview.answer', answer: answerView(row) }); };
  const notifyQuestion = id => { const row = db.prepare('SELECT * FROM interview_questions WHERE id=?').get(id); if (row) event(row.session_id, { type: 'interview.question', question: questionView(row) }); };
  function gap(sessionId, track, startMs, endMs, reason) {
    const interview = getSession(sessionId); if (!interview) return;
    const row = { id: randomUUID(), sessionId, track: track || null, startMs: startMs === null ? null : Math.round(startMs), endMs: endMs === null ? null : Math.round(endMs), reason: String(reason).slice(0, 300), status: 'unresolved', createdAt: now() };
    db.prepare('INSERT INTO interview_gaps(id,session_id,track,start_ms,end_ms,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id, sessionId, row.track, row.startMs, row.endMs, row.reason, row.status, row.createdAt);
    event(sessionId, { type: 'interview.audio.status', status: 'interrupted', error: row.reason, gap: row });
  }
  function audioStatus(sessionId, value, error, mode) {
    if (!getSession(sessionId)) return;
    if (mode !== 'replay') db.prepare('UPDATE interviews SET recording_status=?,error=?,updated_at=? WHERE id=?').run(value, error || null, now(), sessionId);
    event(sessionId, { type: 'interview.audio.status', status: value, error: error || null, mode });
    if (mode !== 'replay') notifyInterview(sessionId);
  }
  const stopAuto = id => { const pending = auto.get(id); if (pending) clearTimeout(pending.timer); auto.delete(id); };
  const cancelAnswer = id => {
    const row = db.prepare('SELECT * FROM interview_answers WHERE id=?').get(id); if (!row) return;
    if (['queued','running'].includes(row.status)) {
      db.prepare("UPDATE interview_answers SET status='cancelled',updated_at=?,lease_until=NULL WHERE id=?").run(now(), id);
      active.get(id)?.controller.abort();
      db.prepare("UPDATE interview_questions SET status='cancelled',updated_at=? WHERE id=? AND revision=?").run(now(), row.question_id, row.question_revision);
      notifyQuestion(row.question_id); notifyAnswer(id);
    }
  };
  function queueAnswer(interview, question) {
    const id = randomUUID(), timestamp = now();
    let cancelled;
    const row = db.transaction(() => {
      const existing = db.prepare("SELECT * FROM interview_answers WHERE question_id=? AND question_revision=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(question.id, question.revision);
      if (existing) return existing;
      const owner = user(interview.user_id); if (!owner || owner.disabled) fail(403, '账号不可用');
      if (db.prepare('SELECT count(*) AS n FROM quota_events WHERE user_id=? AND created_at>=?').get(owner.id, timestamp.slice(0,10)).n >= owner.daily_limit) fail(429, '已达到今日任务额度');
      if (db.prepare('SELECT count(*) AS n FROM interview_answers WHERE session_id=?').get(interview.id).n >= 2000) fail(429, '本场面试回答数量已达上限');
      cancelled = db.prepare("SELECT id,question_id,question_revision FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").all(interview.id);
      for (const old of cancelled) {db.prepare("UPDATE interview_answers SET status='cancelled',updated_at=?,lease_until=NULL WHERE id=?").run(timestamp, old.id);db.prepare("UPDATE interview_questions SET status='cancelled',updated_at=? WHERE id=? AND revision=?").run(timestamp,old.question_id,old.question_revision);}
      db.prepare('INSERT INTO interview_answers(id,session_id,question_id,question_revision,provider,status,created_at,updated_at) VALUES(?,?,?,?,?,\'queued\',?,?)').run(id, interview.id, question.id, question.revision, interview.provider, timestamp, timestamp);
      db.prepare("UPDATE interview_questions SET status='pending',updated_at=? WHERE id=?").run(timestamp, question.id);
      db.prepare('INSERT INTO quota_events(id,user_id,created_at) VALUES(?,?,?)').run(randomUUID(), owner.id, timestamp);
      return db.prepare('SELECT * FROM interview_answers WHERE id=?').get(id);
    })();
    for (const old of cancelled || []) { active.get(old.id)?.controller.abort(); notifyQuestion(old.question_id);notifyAnswer(old.id); }
    notifyQuestion(question.id); notifyAnswer(row.id); setImmediate(() => void pump());
    return row;
  }
  async function execute(answer, controller) {
    const jobDir = path.join(dataDir, 'jobs', `interview-${answer.id}-${randomUUID()}`);
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs); timeout.unref();
    const lease = setInterval(() => { const row = db.prepare('SELECT status FROM interview_answers WHERE id=?').get(answer.id); if (!row || row.status !== 'running') return controller.abort(); db.prepare('UPDATE interview_answers SET lease_until=? WHERE id=?').run(new Date(Date.now() + timeoutMs + 30000).toISOString(), answer.id); }, 3000); lease.unref();
    try {
      const interview = getSession(answer.session_id), question = db.prepare('SELECT * FROM interview_questions WHERE id=?').get(answer.question_id);
      if (!interview || !question || question.revision !== answer.question_revision || user(interview.user_id)?.disabled) throw new Error('stale question');
      await mkdir(jobDir, { recursive: true, mode: 0o700 });
      const allSegments = db.prepare('SELECT * FROM interview_segments WHERE session_id=? AND final=1 ORDER BY start_ms,rowid').all(interview.id).map(segmentView);
      const ids = parse(interview.knowledge_ids);
      const files = ids.length ? db.prepare(`SELECT name,text FROM knowledge WHERE user_id=? AND status='ready' AND id IN (${ids.map(() => '?').join(',')})`).all(interview.user_id, ...ids) : [];
      const context = assembleInterviewContext({ style: interview.style_snapshot, question: question.text, segments: allSegments, files, budget: contextBudget });
      const snapshotId = randomUUID();
      db.prepare('INSERT INTO interview_contexts(id,session_id,question_id,prompt,sources,summary,segment_ids,watermark,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(snapshotId, interview.id, question.id, context.prompt, JSON.stringify(context.sources), context.summary, JSON.stringify(context.segmentIds), context.watermark, now());
      db.prepare("UPDATE interview_answers SET context_snapshot_id=? WHERE id=? AND status='running'").run(snapshotId, answer.id);
      db.prepare("UPDATE interview_questions SET status='answering',updated_at=? WHERE id=? AND revision=?").run(now(), question.id, question.revision); notifyQuestion(question.id); notifyAnswer(answer.id);
      let accumulated = '', lastSave = 0;
      const result = await textRunner({ provider: answer.provider, prompt: context.prompt, jobDir, sessionId: interview.id, userId: interview.user_id, signal: controller.signal, onDelta(delta) {
        if (controller.signal.aborted || typeof delta !== 'string') return;
        accumulated += delta;
        if (accumulated.length > 200000) { controller.abort(Object.assign(new Error('output limit'), { code: 'AI_OUTPUT_LIMIT' })); return; }
        event(interview.id, { type: 'interview.answer.delta', answerId: answer.id, delta });
        if (Date.now() - lastSave >= 400) { db.prepare("UPDATE interview_answers SET text=?,updated_at=? WHERE id=? AND status='running'").run(accumulated, now(), answer.id); lastSave = Date.now(); }
      } });
      if (controller.signal.aborted) throw controller.signal.reason || new Error('cancelled');
      if (!result?.answer?.trim()) throw Object.assign(new Error('empty'), { code: 'AI_EMPTY_OUTPUT' });
      db.prepare("UPDATE interview_answers SET status='completed',text=?,usage=?,error=NULL,updated_at=?,lease_until=NULL WHERE id=? AND status='running'").run(result.answer.slice(0,200000), result.usage ? JSON.stringify(result.usage) : null, now(), answer.id);
      db.prepare("UPDATE interview_questions SET status='answered',updated_at=? WHERE id=? AND revision=?").run(now(), question.id, question.revision);
    } catch (error) {
      const current = db.prepare('SELECT status FROM interview_answers WHERE id=?').get(answer.id);
      if (current?.status === 'running') {
        if (controller.signal.reason?.code === 'SHUTDOWN') db.prepare("UPDATE interview_answers SET status='queued',text='',error=NULL,updated_at=?,lease_until=NULL WHERE id=?").run(now(), answer.id);
        else {
          const messages = { AI_NOT_CONFIGURED: '尚未配置该文本模型，请管理员配置百炼文本 API Key 或选择已登录的 Codex / Claude', AI_CLI_NOT_FOUND: '未找到文本模型 CLI，请检查服务账号安装和配置', AI_TIMEOUT: '回答生成超时，可重新提问或调整云端超时设置', AI_EMPTY_OUTPUT: '模型未返回回答，请检查模型服务后重试', AI_OUTPUT_LIMIT: '回答过长已中止，请使用更简洁的回答风格' };
          const message = controller.signal.reason?.code === 'TIMEOUT' ? messages.AI_TIMEOUT : messages[error?.code] || messages[controller.signal.reason?.code] || '回答生成失败，请检查云端模型认证、网络和配置';
          db.prepare("UPDATE interview_answers SET status='failed',error=?,updated_at=?,lease_until=NULL WHERE id=?").run(message, now(), answer.id);
          db.prepare("UPDATE interview_questions SET status='failed',updated_at=? WHERE id=? AND revision=?").run(now(),answer.question_id,answer.question_revision);
        }
      }
    } finally {
      clearTimeout(timeout); clearInterval(lease); notifyAnswer(answer.id); notifyQuestion(answer.question_id);
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const claim = db.transaction(() => {
    const timestamp = now();
    db.prepare("UPDATE interview_answers SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,error=CASE WHEN attempts<3 THEN NULL ELSE '回答任务多次中断，请重新生成' END,lease_until=NULL,updated_at=? WHERE status='running' AND lease_until<?").run(timestamp, timestamp);
    const busy = [...active.values()].map(value => value.sessionId);
    const row = db.prepare(`SELECT a.* FROM interview_answers a JOIN interviews i ON i.id=a.session_id JOIN users u ON u.id=i.user_id WHERE a.status='queued' AND u.disabled=0 ${busy.length ? `AND a.session_id NOT IN (${busy.map(() => '?').join(',')})` : ''} ORDER BY a.created_at DESC LIMIT 1`).get(...busy);
    if (!row) return null;
    return db.prepare("UPDATE interview_answers SET status='running',text='',updated_at=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status='queued'").run(timestamp, new Date(Date.now()+timeoutMs+30000).toISOString(), row.id).changes ? row : null;
  });
  async function pump() {
    if (closed || pumping) return; pumping = true;
    try { while (!closed && active.size < concurrency) { const row = claim(); if (!row) break; const controller = new AbortController(); const promise = execute(row, controller).finally(() => { active.delete(row.id); const interview = getSession(row.session_id); if (interview?.status === 'ended') void textRunner.closeSession?.(row.session_id); setImmediate(() => void pump()); }); active.set(row.id, { controller, promise, sessionId: row.session_id }); } }
    finally { pumping = false; }
  }
  function createQuestion(interview, input, origin = 'manual') {
    let ids = input.segmentIds || [];
    if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string' || id.length > 80)) fail(400, '请选择有效的远端终稿语句');
    ids = [...new Set(ids)]; let questionText = input.text === undefined ? '' : text(input.text, '问题', 8000, false);
    if (ids.length) {
      const segments = db.prepare(`SELECT * FROM interview_segments WHERE session_id=? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY start_ms`).all(interview.id, ...ids);
      if (segments.length !== ids.length || segments.some(s => s.track !== 'remote' || !s.final)) fail(400, '只能选择本场面试中已完成的远端发言');
      if (!questionText) questionText = segments.map(s => s.text).join('\n');
      ids = segments.map(s => s.id);
      const existing = db.prepare('SELECT * FROM interview_questions WHERE session_id=? AND segment_ids=? ORDER BY created_at DESC LIMIT 1').get(interview.id, JSON.stringify(ids));
      if (existing) return { question: existing, answer: queueAnswer(interview, existing) };
    }
    if (!questionText.trim()) fail(400, '请输入问题，或选择远端发言');
    if (db.prepare('SELECT count(*) AS n FROM interview_questions WHERE session_id=?').get(interview.id).n >= 1000) fail(429, '本场面试问题数量已达上限');
    const id = randomUUID(), timestamp = now();
    db.transaction(() => { db.prepare('INSERT INTO interview_questions(id,session_id,text,segment_ids,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, interview.id, questionText.slice(0,8000), JSON.stringify(ids), origin, timestamp, timestamp); for (const segmentId of ids) db.prepare('INSERT INTO interview_question_segments(question_id,segment_id) VALUES(?,?)').run(id, segmentId); })();
    const question = db.prepare('SELECT * FROM interview_questions WHERE id=?').get(id); notifyQuestion(id);
    return { question, answer: queueAnswer(interview, question) };
  }
  function flushAuto(sessionId) {
    const pending = auto.get(sessionId); stopAuto(sessionId); if (!pending) return;
    const interview = getSession(sessionId); if (closed || !interview || !interview.auto_answer || user(interview.user_id)?.disabled) return;
    const segments = pending.ids.map(id => db.prepare('SELECT * FROM interview_segments WHERE id=? AND session_id=?').get(id, sessionId)).filter(Boolean);
    if (!segments.length || !isQuestion(segments.map(s => s.text).join(' '))) return;
    try { createQuestion(interview, { segmentIds: segments.map(s => s.id) }, 'auto'); }
    catch (error) { event(sessionId, { type: 'interview.audio.status', status: 'answer_error', error: error.status ? error.message : '无法创建自动回答，请尝试手动提问' }); }
  }
  function recordSegment(sessionId, track, key, result, replay) {
    const interview = getSession(sessionId);
    if (!interview || !['remote','self'].includes(track) || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 16000 || !Number.isFinite(result.startMs) || result.startMs < 0 || result.startMs > maxSessionMinutes*60000) return;
    if (result.endMs !== null && result.endMs !== undefined && (!Number.isFinite(result.endMs) || result.endMs < result.startMs || result.endMs > maxSessionMinutes*60000+1000)) return;
    if (replay && !result.final) return;
    let existing = db.prepare('SELECT * FROM interview_segments WHERE session_id=? AND track=? AND segment_key=?').get(sessionId, track, key);
    if (!existing && replay && result.final) existing = db.prepare('SELECT * FROM interview_segments WHERE session_id=? AND track=? AND final=1 AND abs(start_ms-?)<30 AND abs(COALESCE(end_ms,0)-?)<30 ORDER BY updated_at DESC LIMIT 1').get(sessionId, track, result.startMs, result.endMs || 0);
    if (existing?.final && !result.final) return;
    if (existing && existing.text === result.text && !!existing.final === !!result.final && existing.end_ms === (result.endMs ?? null)) return;
    if (!existing && db.prepare('SELECT count(*) AS n FROM interview_segments WHERE session_id=?').get(sessionId).n >= 50000) { audioStatus(sessionId, 'error', '转写片段数量达到上限，请结束后重新开始面试', 'live'); return; }
    const id = existing?.id || randomUUID(), revision = (existing?.revision || 0)+1, timestamp = now();
    db.transaction(() => {
      if (existing) db.prepare('UPDATE interview_segments SET text=?,start_ms=?,end_ms=?,final=?,revision=?,updated_at=? WHERE id=?').run(result.text, Math.round(result.startMs), result.endMs === null || result.endMs === undefined ? null : Math.round(result.endMs), result.final ? 1 : 0, revision, timestamp, id);
      else db.prepare('INSERT INTO interview_segments(id,session_id,track,segment_key,text,start_ms,end_ms,final,revision,replay,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, sessionId, track, key.slice(0,200), result.text, Math.round(result.startMs), result.endMs === null || result.endMs === undefined ? null : Math.round(result.endMs), result.final ? 1 : 0, revision, replay ? 1 : 0, timestamp, timestamp);
      db.prepare('INSERT INTO interview_segment_revisions(segment_id,revision,text,final,start_ms,end_ms,created_at) SELECT id,revision,text,final,start_ms,end_ms,updated_at FROM interview_segments WHERE id=?').run(id);
      db.prepare('UPDATE interviews SET updated_at=? WHERE id=?').run(timestamp, sessionId);
    })();
    const saved = db.prepare('SELECT * FROM interview_segments WHERE id=?').get(id); event(sessionId, { type: 'interview.segment', segment: segmentView(saved) });
    if (result.final && track === 'remote') {
      const linked = db.prepare('SELECT q.* FROM interview_questions q JOIN interview_question_segments l ON l.question_id=q.id WHERE l.segment_id=?').all(id);
      for (const question of linked) {
        const segmentIds = parse(question.segment_ids), content = segmentIds.map(segmentId => db.prepare('SELECT text FROM interview_segments WHERE id=?').get(segmentId)?.text || '').join('\n');
        db.prepare("UPDATE interview_questions SET text=?,revision=revision+1,status='pending',updated_at=? WHERE id=?").run(content, timestamp, question.id);
        for (const answer of db.prepare("SELECT id FROM interview_answers WHERE question_id=? AND status IN ('queued','running')").all(question.id)) cancelAnswer(answer.id);
        notifyQuestion(question.id);
        if (!closed && !replay && interview.auto_answer && interview.status === 'recording') try { queueAnswer(interview, db.prepare('SELECT * FROM interview_questions WHERE id=?').get(question.id)); } catch {}
      }
      if (!closed && !replay && !linked.length && interview.auto_answer && interview.status === 'recording' && !user(interview.user_id)?.disabled) {
        const pending = auto.get(sessionId) || { ids: [], timer: null };
        if (!pending.ids.includes(id)) pending.ids.push(id);
        if (pending.ids.length > 50) pending.ids.shift();
        clearTimeout(pending.timer); pending.timer = setTimeout(() => flushAuto(sessionId), debounceMs); pending.timer.unref(); auto.set(sessionId, pending);
      }
    }
  }
  const maxDailyMinutes=boundedNumber(options.maxDailyMinutes??process.env.ASR_DAILY_MINUTES,480,1,2880);
  const audio = attachInterviewAudio({ server, db, dataDir, publicOrigin, asrFactory: asrFactory || createDashScopeAsrFactory(asr), recordSegment, status: audioStatus, gap, maxSessionMinutes, retentionDays, maxDailyMinutes, maxUserBytes: boundedNumber(options.maxUserAudioBytes ?? process.env.AUDIO_MAX_USER_BYTES, 512*1024*1024, 1024*1024, 2*1024*1024*1024) });
  db.prepare("UPDATE interview_answers SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,lease_until=NULL,updated_at=? WHERE status='running'").run(now());

  // Surviving recordings cannot truthfully remain "recording" after a restart.
  for (const old of db.prepare("SELECT * FROM interviews WHERE status='recording'").all()) { db.prepare("UPDATE interviews SET status='paused',recording_status='interrupted',error='服务器已重启，请恢复录音并补传本地缓存',updated_at=? WHERE id=?").run(now(), old.id); gap(old.id, null, null, null, '服务器重启造成录音中断'); }
  const prepare = interview => { if (textRunner.prepareSession && interview.status === 'recording') void Promise.resolve(textRunner.prepareSession({ userId: interview.user_id, sessionId: interview.id,provider:interview.provider })).catch(() => { /* A model failure never masquerades as an ASR recording failure. */ }); };
  router.get('/config', (req, res) => res.json({ configured, model: asrConfig.model, region: asrConfig.region, sampleRate: 16000, maxSessionMinutes,maxDailyMinutes, rawAudioRetentionDays: retentionDays, autoAnswerAvailable: true, providers: ['codex','claude', ...(process.env.INTERVIEW_TEXT_API_KEY || process.env.DASHSCOPE_API_KEY || asrConfig.apiKey || !lazyRunner ? ['bailian'] : [])], defaultProvider }));
  router.get('/', (req, res) => { const limit = Math.max(1,Math.min(200,parseInt(req.query.limit,10)||50)); res.json({ interviews: db.prepare('SELECT * FROM interviews WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(req.identity.userId, limit).map(interviewView) }); });
  router.post('/', (req, res) => {
    const owner = req.identity.userId, body = req.body;
    const provider = body.provider || defaultProvider; if (!validProviders.includes(provider)) fail(400, '不支持的面试回答模型');
    if (body.autoAnswer !== undefined && typeof body.autoAnswer !== 'boolean') fail(400, '自动回答设置无效');
    const hotwords = body.hotwords || []; if (!Array.isArray(hotwords) || hotwords.length > 200 || hotwords.some(word => typeof word !== 'string' || !word.trim() || word.length > 80)) fail(400, '热词最多 200 个，每个不超过 80 个字符');
    let row;
    db.transaction(() => {
      if (db.prepare("SELECT id FROM interviews WHERE user_id=? AND status='recording'").get(owner)) fail(409, '已有正在进行的面试，请先暂停或结束');
      if (db.prepare('SELECT count(*) AS n FROM interviews WHERE user_id=?').get(owner).n >= 200) fail(429, '面试会话数量已达上限，请导出并删除旧记录');
      const prompt = body.promptId ? db.prepare('SELECT * FROM prompts WHERE id=? AND user_id=?').get(body.promptId, owner) : db.prepare('SELECT * FROM prompts WHERE user_id=? ORDER BY is_default DESC,created_at LIMIT 1').get(owner);
      if (body.promptId && !prompt) fail(404, '回答风格不存在');
      const id = randomUUID(), timestamp = now();
      const files = db.prepare("SELECT id FROM knowledge WHERE user_id=? AND status='ready'").all(owner).map(file => file.id);
      db.prepare('INSERT INTO interviews(id,user_id,device_id,title,status,provider,prompt_id,prompt_name,style_snapshot,knowledge_ids,hotwords,auto_answer,created_at,updated_at) VALUES(?,?,?,?,\'recording\',?,?,?,?,?,?,?,?,?)').run(id, owner, req.identity.deviceId || null, body.title ? text(body.title,'面试名称',120) : '面试 '+timestamp.slice(0,16).replace('T',' '), provider, prompt?.id || null, prompt?.name || '默认回答风格', prompt?.content || '中文，先给结论再给关键依据，不编造个人经历。', JSON.stringify(files), JSON.stringify(hotwords.map(word => word.trim())), body.autoAnswer === false ? 0 : 1, timestamp, timestamp);
      row = getSession(id);
    })();
    prepare(row); notifyInterview(row.id); res.status(201).json({ interview: interviewView(row) });
  });
  function detail(row, { full = false, beforeStartMs, cursor } = {}) {
    let segments;
    if (full) segments = db.prepare('SELECT * FROM interview_segments WHERE session_id=? ORDER BY start_ms,rowid').all(row.id);
    else if(typeof cursor==='string'&&/^\d+:\d+$/.test(cursor)){const [time,index]=cursor.split(':').map(Number);segments=db.prepare('SELECT *,rowid AS cursor_rowid FROM interview_segments WHERE session_id=? AND (start_ms<? OR (start_ms=? AND rowid<?)) ORDER BY start_ms DESC,rowid DESC LIMIT 2001').all(row.id,time,time,index);}
    else segments = db.prepare(`SELECT *,rowid AS cursor_rowid FROM interview_segments WHERE session_id=? ${Number.isFinite(beforeStartMs) ? 'AND start_ms<?' : ''} ORDER BY start_ms DESC,rowid DESC LIMIT 2001`).all(row.id, ...(Number.isFinite(beforeStartMs) ? [beforeStartMs] : []));
    const truncated = !full && segments.length > 2000; if (truncated) segments.pop(); if (!full) segments.reverse();
    const context = db.prepare('SELECT id,summary,segment_ids,watermark,created_at FROM interview_contexts WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(row.id);
    return { interview: interviewView(row), segments: segments.map(segmentView), segmentsTruncated: truncated, nextCursor: truncated ? `${segments[0].start_ms}:${segments[0].cursor_rowid}` : null,
      questions: db.prepare('SELECT * FROM interview_questions WHERE session_id=? ORDER BY created_at').all(row.id).map(questionView),
      answers: db.prepare('SELECT * FROM interview_answers WHERE session_id=? ORDER BY created_at').all(row.id).map(answerView),
      gaps: db.prepare('SELECT * FROM interview_gaps WHERE session_id=? ORDER BY created_at').all(row.id).map(g => ({ id:g.id, sessionId:g.session_id, track:g.track, startMs:g.start_ms, endMs:g.end_ms, reason:g.reason, status:g.status, createdAt:g.created_at })),
      contextSummary: context ? { ...context, segmentIds: parse(context.segment_ids) } : null };
  }
  router.get('/:id', (req, res) => res.json(detail(own(req.params.id,req.identity.userId), { cursor:req.query.cursor,beforeStartMs: req.query.beforeStartMs === undefined ? undefined : Number(req.query.beforeStartMs) })));
  router.patch('/:id', (req, res) => {
    const row = own(req.params.id,req.identity.userId), body = req.body;
    if (body.autoAnswer !== undefined && typeof body.autoAnswer !== 'boolean') fail(400, '自动回答设置无效');
    if (body.provider !== undefined && !validProviders.includes(body.provider)) fail(400, '不支持的面试回答模型');
    if (body.provider && body.provider !== row.provider) { for (const answer of db.prepare("SELECT id FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").all(row.id)) cancelAnswer(answer.id); void textRunner.closeSession?.(row.id); }
    db.prepare('UPDATE interviews SET title=?,auto_answer=?,provider=?,updated_at=? WHERE id=?').run(body.title === undefined ? row.title : text(body.title,'面试名称',120), body.autoAnswer === undefined ? row.auto_answer : body.autoAnswer ? 1 : 0, body.provider || row.provider, now(), row.id);
    if (body.autoAnswer === false) stopAuto(row.id); notifyInterview(row.id); res.json({ interview: interviewView(getSession(row.id)) });
  });
  async function transition(row, action) {
    if (action === 'resume') {
      if (row.status === 'ended') fail(409, '已结束的面试不能恢复录音');
      if (db.prepare("SELECT id FROM interviews WHERE user_id=? AND status='recording' AND id<>?").get(row.user_id,row.id)) fail(409, '另有正在进行的面试');
      if (Date.now()-Date.parse(row.created_at) > maxSessionMinutes*60000) fail(409, '面试时间已超过上限，请新建会话');
      db.prepare("UPDATE interviews SET status='recording',recording_status='awaiting_device',error=NULL,updated_at=? WHERE id=?").run(now(),row.id); prepare(getSession(row.id));
    } else {
      if (row.status === 'ended' && action === 'pause') fail(409, '面试已经结束');
      await audio.stopSession(row.id, { drain:true });
      flushAuto(row.id);
      const timestamp=now(); db.prepare('UPDATE interviews SET status=?,recording_status=?,updated_at=?,ended_at=? WHERE id=?').run(action === 'end' ? 'ended' : 'paused', action === 'end' ? 'ended' : 'paused', timestamp, action === 'end' ? timestamp : null, row.id);
      if (![...active.values()].some(a => a.sessionId === row.id)) await textRunner.closeSession?.(row.id);
    }
    notifyInterview(row.id); return getSession(row.id);
  }
  for (const action of ['pause','resume','end']) router.post(`/:id/${action}`, route(async (req,res) => res.json({ interview: interviewView(await transition(own(req.params.id,req.identity.userId), action)) })));
  router.post('/:id/audio-ticket', (req,res) => {
    const row = own(req.params.id,req.identity.userId);
    if (req.identity.kind !== 'device') fail(403, '请从已配对的 Windows 客户端开始录音');
    if (!configured) fail(503, '尚未配置实时语音识别，请管理员设置百炼 API Key、业务空间和地域', 'ASR_NOT_CONFIGURED');
    const mode = req.body.mode || 'live'; if (!['live','replay'].includes(mode)) fail(400, '音频传输模式无效');
    if (mode === 'live' && row.status !== 'recording') fail(409, '请先恢复面试录音');
    if (row.device_id && row.device_id !== req.identity.deviceId) fail(403, '本场面试已由另一台电脑录音');
    if (!row.device_id) { if (mode === 'replay' && row.status === 'ended') fail(403,'结束后的录音只能由原设备回补'); db.prepare('UPDATE interviews SET device_id=?,updated_at=? WHERE id=?').run(req.identity.deviceId,now(),row.id); }
    const ticket = randomToken(), expiresAt = new Date(Date.now()+30000).toISOString();
    db.prepare('INSERT INTO interview_audio_tickets(token_hash,session_id,user_id,device_id,mode,expires_at) VALUES(?,?,?,?,?,?)').run(hash(ticket),row.id,row.user_id,req.identity.deviceId,mode,expiresAt);
    res.json({ ticket, path:'/audio?ticket='+encodeURIComponent(ticket), expiresAt });
  });
  router.post('/:id/questions', (req,res) => {
    const row = own(req.params.id,req.identity.userId), result = createQuestion(row,req.body);
    res.status(201).json({ question:questionView(result.question), answer:answerView(result.answer) });
  });
  router.post('/:id/questions/:qid/answer', (req,res) => {
    const row=own(req.params.id,req.identity.userId), question=db.prepare('SELECT * FROM interview_questions WHERE id=? AND session_id=?').get(req.params.qid,row.id);
    if(!question)fail(404,'面试问题不存在'); const answer=queueAnswer(row,question);res.status(201).json({question:questionView(question),answer:answerView(answer)});
  });
  router.post('/:id/answers/:aid/cancel', (req,res) => {
    const row=own(req.params.id,req.identity.userId), answer=db.prepare('SELECT * FROM interview_answers WHERE id=? AND session_id=?').get(req.params.aid,row.id);if(!answer)fail(404,'回答不存在');cancelAnswer(answer.id);res.json({answer:answerView(db.prepare('SELECT * FROM interview_answers WHERE id=?').get(answer.id))});
  });
  router.get('/:id/export', (req,res) => {
    const row=own(req.params.id,req.identity.userId), data=detail(row,{full:true}), format=req.query.format||'json';
    res.set('Content-Disposition',`attachment; filename="interview-${row.id}.${format==='md'?'md':'json'}"`);
    if(format==='json')return res.json(data); if(format!=='md')fail(400,'导出格式只支持 JSON 或 Markdown');
    const lines=[`# ${row.title}`,`开始：${row.created_at}`,`结束：${row.ended_at||'未结束'}`,'','## 实际对话（远端 / 本人）',''];
    for(const s of data.segments)lines.push(`**${(s.startMs/1000).toFixed(1)}s ${s.track==='self'?'本人':'远端'}${s.final?'':'（临时识别）'}**`,s.text,'');
    lines.push('## AI 建议（不代表本人实际说过）','');for(const answer of data.answers){const q=data.questions.find(x=>x.id===answer.questionId);lines.push(`### ${q?.text||'问题'}（问题版本 ${answer.questionRevision}）`,`状态：${answer.status}`,answer.text||answer.error||'尚无回答','');}
    if(data.gaps.length){lines.push('## 录音缺口与恢复记录','');for(const g of data.gaps)lines.push(`- ${g.reason}${g.startMs!==null?'，位置 '+(g.startMs/1000).toFixed(1)+'s':''}`);}
    res.type('text/markdown; charset=utf-8').send(lines.join('\n'));
  });
  router.get('/:id/audio/:track', route(async (req,res) => { const row=own(req.params.id,req.identity.userId);await downloadInterviewAudio({db,dataDir,interview:row,track:req.params.track,res}); }));
  router.delete('/:id', route(async (req,res) => {
    const row=own(req.params.id,req.identity.userId);stopAuto(row.id);for(const answer of db.prepare("SELECT id FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").all(row.id))cancelAnswer(answer.id);
    await audio.stopSession(row.id,{drain:false});await Promise.all([...active.values()].filter(a=>a.sessionId===row.id).map(a=>a.promise));await textRunner.closeSession?.(row.id);await audio.removeFiles(row);db.prepare('DELETE FROM interviews WHERE id=?').run(row.id);publish(row.user_id,{sessionId:row.id,type:'interview.deleted'});res.json({ok:true});
  }));
  const timer=setInterval(()=>void pump().catch(()=>{}),100);timer.unref();
  let maintenanceTask=Promise.resolve();
  async function cleanupAudio(){
    const cutoff=new Date(Date.now()-Math.max(0,retentionDays)*86400000).toISOString();
    const expired=db.prepare("SELECT DISTINCT i.* FROM interviews i JOIN interview_audio_frames f ON f.session_id=i.id WHERE i.status<>'recording' AND COALESCE(i.ended_at,i.updated_at)<? AND f.byte_offset IS NOT NULL").all(cutoff);
    for(const row of expired)await audio.removeFiles(row);
  }
  await cleanupAudio();
  const maintenance=setInterval(()=>{
    maintenanceTask=maintenanceTask.catch(()=>{}).then(async()=>{for(const row of db.prepare("SELECT * FROM interviews WHERE status='recording' AND created_at<?").all(new Date(Date.now()-maxSessionMinutes*60000).toISOString()))await transition(row,'end');await cleanupAudio();}).catch(()=>{});
  },60000);maintenance.unref();
  function interruptRows(rows,reason){for(const row of rows){stopAuto(row.id);db.prepare("UPDATE interviews SET status='paused',recording_status='interrupted',error=?,updated_at=? WHERE id=? AND status='recording'").run(reason,now(),row.id);for(const answer of db.prepare("SELECT id FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").all(row.id))cancelAnswer(answer.id);gap(row.id,null,null,null,reason);notifyInterview(row.id);void textRunner.closeSession?.(row.id);}}
  return {router,recordSegment,flushAuto,pump,configured,cleanupAudio,
    revokeDevice(deviceId){interruptRows(db.prepare("SELECT * FROM interviews WHERE device_id=? AND status='recording'").all(deviceId),'录音设备配对已撤销');audio.revokeDevice(deviceId);},
    revokeUser(userId){interruptRows(db.prepare("SELECT * FROM interviews WHERE user_id=?").all(userId),'账号不可用，录音已停止');audio.revokeUser(userId);},
    async idle(){await Promise.all([...active.values()].map(a=>a.promise));},
    async close(){if(closed)return;closed=true;clearInterval(timer);clearInterval(maintenance);for(const id of auto.keys())stopAuto(id);for(const item of active.values())item.controller.abort(Object.assign(new Error('shutdown'),{code:'SHUTDOWN'}));await maintenanceTask;await audio.close();await Promise.all([...active.values()].map(a=>a.promise));for(const row of db.prepare("SELECT * FROM interviews WHERE status='recording'").all()){db.prepare("UPDATE interviews SET status='paused',recording_status='interrupted',error='服务器停止，录音已暂停',updated_at=? WHERE id=?").run(now(),row.id);}await textRunner.close?.();}
  };
}
