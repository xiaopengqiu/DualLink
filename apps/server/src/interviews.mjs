import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { hash, randomToken, now, fail, text } from './auth.mjs';
import { asrConfiguration, createDashScopeAsrFactory } from './asr.mjs';
import { attachInterviewAudio, downloadInterviewAudio } from './audio.mjs';
import { nativeAudioConfiguration } from './native-audio-providers.mjs';
import { assembleInterviewContext, isQuestion } from './interview-context.mjs';
import { modelId, modelMap, defaultTextModel } from './model-settings.mjs';

const parse = (value, fallback = []) => { try { return JSON.parse(value); } catch { return fallback; } };
const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const boundedNumber = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));

export async function createInterviewService({ server, db, dataDir, publicOrigin, publish, textRunner, audioRunner, omni = {}, cli = {}, asr = {}, asrFactory, options = {}, accountAi }) {
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
    lazyRunner = createTextRunner({ ...cli, timeoutMs, runtimeRoot: path.join(dataDir, 'jobs', 'warm') });
    textRunner = async input=>{
      const p=accountAi?.profile('transcript.'+input.provider)||{};
      if(!p.apiKey&&!p.baseUrl&&!p.workspaceId&&!p.region)return lazyRunner(input);
      let settings=accountAi.cli('transcript',input.provider,{...cli,timeoutMs,codexTransport:'exec'});
      if(input.provider==='bailian')settings=accountAi.api('transcript.bailian',settings);
      const run=createTextRunner(settings);
      try{return await run(input);}finally{await run.close();}
    };
    textRunner.close=()=>lazyRunner.close();
    textRunner.closeSession=id=>lazyRunner.closeSession(id);
    textRunner.prepareSession=input=>Object.values(accountAi?.profile('transcript.'+input.provider)||{}).some(Boolean)?Promise.resolve({prepared:false}):lazyRunner.prepareSession(input);
  }
  const omniConfig=nativeAudioConfiguration(omni),omniModel=omniConfig.model,audioModels=omniConfig.models;
  const audioConfigured=!!audioRunner||omniConfig.configured;
  const asrModels=[...new Set([asrConfig.model,...(process.env.ASR_MODELS||'').split(',').map(x=>x.trim()).filter(Boolean)])];
  const customAsrModelsAllowed=!process.env.ASR_MODELS,customAudioModelsAllowed=omniConfig.customModelsAllowed;
  const serverDefaults={mode:process.env.INTERVIEW_DEFAULT_MODE||'transcript',provider:defaultProvider,textModels:{codex:'',claude:'',bailian:''},asrModel:asrConfig.model,transcribe:true,audioModel:omniModel,audioWindowSeconds:boundedNumber(process.env.INTERVIEW_AUDIO_WINDOW_SECONDS,120,15,180)};
  const defaults=id=>{const value={...serverDefaults,...parse(db.prepare('SELECT value FROM interview_preferences WHERE user_id=?').get(accountAi?.owner() || id)?.value,{})};return {...value,asrModel:value.asrModel||asrConfig.model,audioModel:value.audioModel||omniModel};};
  // Legacy copied defaults are not explicit overrides. Resolve inherited values at submission time.
  const effectiveSession=row=>{
    if(!row)return row;
    const inherited=defaults(row.user_id), overrides=parse(row.model_overrides,{});
    const models={...inherited.textModels,...overrides.textModels};
    for(const provider of validProviders)models[provider]=models[provider]||defaultTextModel(provider,cli);
    return {...row,provider:overrides.provider||inherited.provider,text_models:JSON.stringify(models),asr_model:overrides.asrModel||inherited.asrModel,audio_model:overrides.audioModel||inherited.audioModel};
  };
  const overridePatch=(current,body,uid,previousModels=null)=>{
    const result={...current,textModels:{...current.textModels}},inherited=defaults(uid);
    for(const key of ['provider','asrModel','audioModel'])if(body[key]!==undefined){if(!body[key]||body[key]===inherited[key])delete result[key];else result[key]=body[key];}
    if(body.textModels)for(const [provider,model] of Object.entries(body.textModels)){if(model&&previousModels&&model===previousModels[provider])continue;if(!model||model===inherited.textModels?.[provider])delete result.textModels[provider];else result.textModels[provider]=model;}
    return result;
  };
  const textModelFor=interview=>parse(effectiveSession(interview).text_models,{})[effectiveSession(interview).provider]||defaultTextModel(effectiveSession(interview).provider,cli);
  const validateSettings=(body,current,canConfigure=true)=>{
    if(!canConfigure)body=Object.fromEntries(Object.entries(body).filter(([key])=>!['provider','textModels','asrModel','audioModel'].includes(key)));
    const result={...current};
    if(body.mode!==undefined){if(!['transcript','audio'].includes(body.mode))fail(400,'回答模式无效');result.mode=body.mode;}
    if(body.provider!==undefined){if(!validProviders.includes(body.provider))fail(400,'文字回答模型无效');result.provider=body.provider;}
    if(body.transcribe!==undefined){if(typeof body.transcribe!=='boolean')fail(400,'后台转写设置无效');result.transcribe=body.transcribe;}
    if(body.audioModel!==undefined){modelId(body.audioModel);const selected=body.audioModel||omniModel;if(!customAudioModelsAllowed&&!audioModels.includes(selected)&&selected!==accountAi?.profile('omni').model)fail(400,'音频模型未在服务端配置');result.audioModel=selected;}
    if(body.asrModel!==undefined){modelId(body.asrModel);const selected=body.asrModel||asrConfig.model;if(!customAsrModelsAllowed&&!asrModels.includes(selected)&&selected!==accountAi?.profile('asr').model)fail(400,'转写模型未在服务端配置');result.asrModel=selected;}
    if(body.textModels!==undefined)result.textModels=modelMap(body.textModels,current.textModels);
    if(body.audioWindowSeconds!==undefined){if(!Number.isInteger(body.audioWindowSeconds)||body.audioWindowSeconds<15||body.audioWindowSeconds>180)fail(400,'音频窗口需为15至180秒');result.audioWindowSeconds=body.audioWindowSeconds;}
    return result;
  };
  const router = express.Router(), active = new Map(), auto = new Map();
  let closed = false, pumping = false;
  const own = (id, userId) => { const row = db.prepare('SELECT * FROM interviews WHERE id=? AND user_id=?').get(id, userId); if (!row) fail(404, '面试会话不存在'); return effectiveSession(row); };
  const user = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const interviewView = input => { const row=effectiveSession(input);return ({ id: row.id, title: row.title, status: row.status, provider: row.provider,textModels:modelMap(parse(row.text_models,{})),textModelSources:Object.fromEntries(validProviders.map(p=>[p,parse(row.model_overrides,{}).textModels?.[p]?'本场显式覆盖':defaults(row.user_id).textModels?.[p]?'管理员网页配置':'服务器默认'])),asrModel:row.asr_model||asrConfig.model, promptId: row.prompt_id, promptName: row.prompt_name, autoAnswer: !!row.auto_answer, mode:row.mode,transcribe:!!row.transcribe,audioModel:row.audio_model,audioWindowSeconds:row.audio_window_seconds,audioAvailable:!!db.prepare('SELECT seq FROM interview_audio_frames WHERE session_id=? AND byte_offset IS NOT NULL LIMIT 1').get(row.id), deviceId: row.device_id, recordingStatus: row.recording_status, error: row.error || null, createdAt: row.created_at, endedAt: row.ended_at, updatedAt: row.updated_at });};
  const segmentView = row => ({ id: row.id, sessionId: row.session_id, track: row.track, segmentId: row.segment_key, text: row.text, startMs: row.start_ms, endMs: row.end_ms, final: !!row.final, revision: row.revision, replay: !!row.replay, createdAt: row.created_at, updatedAt: row.updated_at });
  const questionView = row => ({ id: row.id, sessionId: row.session_id, text: row.text, segmentIds: parse(row.segment_ids),audioRange:row.audio_start_ms===null?null:{startMs:row.audio_start_ms,endMs:row.audio_end_ms},audioTruncated:!!row.audio_truncated, revision: row.revision, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
  const answerView = row => {
    const context=row.context_snapshot_id?db.prepare('SELECT id,sources,summary,segment_ids,watermark FROM interview_contexts WHERE id=? AND session_id=?').get(row.context_snapshot_id,row.session_id):null;
    return { id: row.id, sessionId: row.session_id, questionId: row.question_id, questionRevision: row.question_revision, provider: row.provider,model:row.model||null,mode:row.mode,audioModel:row.audio_model, status: row.status, text: row.text, error: row.error || null, contextSnapshotId: row.context_snapshot_id, usage: parse(row.usage, null), createdAt: row.created_at, updatedAt: row.updated_at,
      sources:context?parse(context.sources):[],contextSummary:context?{id:context.id,summary:context.summary,segmentIds:parse(context.segment_ids),watermark:context.watermark}:null };
  };
  const getSession = id => effectiveSession(db.prepare('SELECT * FROM interviews WHERE id=?').get(id));
  const event = (sessionId, value) => { const row = getSession(sessionId); if (row) publish(row.user_id, { sessionId, ...value }); };
  const notifyInterview = id => { const row = getSession(id); if (row) event(id, { type: 'interview.updated', interview: interviewView(row) }); };
  const notifyAnswer = id => { const row = db.prepare('SELECT * FROM interview_answers WHERE id=?').get(id); if (row) event(row.session_id, { type: 'interview.answer', answer: answerView(row) }); };
  const notifyQuestion = id => { const row = db.prepare('SELECT * FROM interview_questions WHERE id=?').get(id); if (row) event(row.session_id, { type: 'interview.question', question: questionView(row) }); };
  function gap(sessionId, track, startMs, endMs, reason, {warning=false}={}) {
    const interview = getSession(sessionId); if (!interview) return;
    const row = { id: randomUUID(), sessionId, track: track || null, startMs: startMs === null ? null : Math.round(startMs), endMs: endMs === null ? null : Math.round(endMs), reason: String(reason).slice(0, 300), status: 'unresolved', createdAt: now() };
    db.prepare('INSERT INTO interview_gaps(id,session_id,track,start_ms,end_ms,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id, sessionId, row.track, row.startMs, row.endMs, row.reason, row.status, row.createdAt);
    event(sessionId, { type: 'interview.audio.status', status: warning?'transcription_warning':'interrupted', error: row.reason, gap: row });
  }
  function audioStatus(sessionId, value, error, mode) {
    if (!getSession(sessionId)) return;
    if (mode !== 'replay') {if(value==='transcription_warning')db.prepare('UPDATE interviews SET error=?,updated_at=? WHERE id=?').run(error,now(),sessionId);else db.prepare('UPDATE interviews SET recording_status=?,error=?,updated_at=? WHERE id=?').run(value,error||null,now(),sessionId);}
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
    interview=effectiveSession(interview);
    const id = randomUUID(), timestamp = now();
    const mode=question.origin==='trigger_audio'?'audio':'transcript';
    let cancelled;
    const row = db.transaction(() => {
      const existing = question.origin.startsWith('trigger_')?null:db.prepare("SELECT * FROM interview_answers WHERE question_id=? AND question_revision=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(question.id, question.revision);
      if (existing) return existing;
      const owner = user(interview.user_id); if (!owner || owner.disabled) fail(403, '账号不可用');
      if (db.prepare('SELECT count(*) AS n FROM quota_events WHERE user_id=? AND created_at>=?').get(owner.id, timestamp.slice(0,10)).n >= owner.daily_limit) fail(429, '已达到今日任务额度');
      if (db.prepare('SELECT count(*) AS n FROM interview_answers WHERE session_id=?').get(interview.id).n >= 2000) fail(429, '本场面试回答数量已达上限');
      cancelled = db.prepare("SELECT id,question_id,question_revision FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").all(interview.id);
      for (const old of cancelled) {db.prepare("UPDATE interview_answers SET status='cancelled',updated_at=?,lease_until=NULL WHERE id=?").run(timestamp, old.id);db.prepare("UPDATE interview_questions SET status='cancelled',updated_at=? WHERE id=? AND revision=?").run(timestamp,old.question_id,old.question_revision);}
      db.prepare('INSERT INTO interview_answers(id,session_id,question_id,question_revision,provider,status,created_at,updated_at) VALUES(?,?,?,?,?,\'queued\',?,?)').run(id, interview.id, question.id, question.revision, interview.provider, timestamp, timestamp);
      db.prepare('UPDATE interview_answers SET mode=?,audio_model=?,provider=? WHERE id=?').run(mode,mode==='audio'?interview.audio_model:null,mode==='audio'?'omni':interview.provider,id);
      db.prepare('UPDATE interview_answers SET model=? WHERE id=?').run(mode==='audio'?interview.audio_model:textModelFor(interview)||null,id);
      db.prepare("UPDATE interview_questions SET status='pending',updated_at=? WHERE id=?").run(timestamp, question.id);
      db.prepare('INSERT INTO quota_events(id,user_id,created_at) VALUES(?,?,?)').run(randomUUID(), owner.id, timestamp);
      return db.prepare('SELECT * FROM interview_answers WHERE id=?').get(id);
    })();
    for (const old of cancelled || []) { active.get(old.id)?.controller.abort(); notifyQuestion(old.question_id);notifyAnswer(old.id); }
    notifyQuestion(question.id); notifyAnswer(row.id); setImmediate(() => void pump());
    return row;
  }
  async function readAudioRange(interview,track,startMs,endMs,currentQuestion=false){
    if(endMs<=startMs)return null;
    const bytes=Math.ceil((endMs-startMs)*16)*2;if(bytes>180*32000)fail(413,'音频问题超过窗口限制');
    const rows=db.prepare('SELECT * FROM interview_audio_frames WHERE session_id=? AND track=? AND start_ms<? AND start_ms+sample_count/16>? AND byte_offset IS NOT NULL ORDER BY start_ms,seq').all(interview.id,track,endMs,startMs);
    if(!rows.length)return null;
    const pcm=Buffer.alloc(bytes),handle=await open(path.join(dataDir,'users',interview.user_id,'interviews',interview.id,`${track}.pcm`),'r');
    try{for(const row of rows){const skip=Math.max(0,Math.round((startMs-row.start_ms)*16));const target=Math.max(0,Math.round((row.start_ms-startMs)*16));const count=Math.min(row.sample_count-skip,pcm.length/2-target);if(count>0){const r=await handle.read(pcm,target*2,count*2,row.byte_offset+skip*2);if(r.bytesRead!==count*2)fail(409,'音频记录不完整，请等待补传或重新录音');}}}finally{await handle.close();}
    return {track,startMs,endMs,pcm,currentQuestion};
  }
  async function readAudioTurns(interview,question){
    if(question.audio_start_ms===null||question.audio_end_ms===null)fail(409,'当前问题没有保留音频，请重新触发');
    const end=question.audio_end_ms,start=question.audio_start_ms,historyStart=Math.max(0,start-30000),turns=[];
    const prior=await readAudioRange(interview,'remote',historyStart,start);if(prior)turns.push(prior);
    const self=await readAudioRange(interview,'self',Math.max(0,end-30000),end);if(self)turns.push(self);
    const current=await readAudioRange(interview,'remote',start,end,true);if(!current)fail(409,'当前问题音频已经过期或未保存');turns.push(current);return turns;
  }
  async function execute(answer, controller) {
    const jobDir = path.join(dataDir, 'jobs', `interview-${answer.id}-${randomUUID()}`);
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs); timeout.unref();
    const lease = setInterval(() => { const row = db.prepare('SELECT status FROM interview_answers WHERE id=?').get(answer.id); if (!row || row.status !== 'running') return controller.abort(); db.prepare('UPDATE interview_answers SET lease_until=? WHERE id=?').run(new Date(Date.now() + timeoutMs + 30000).toISOString(), answer.id); }, 3000); lease.unref();
    try {
      const interview = getSession(answer.session_id), question = db.prepare('SELECT * FROM interview_questions WHERE id=?').get(answer.question_id);
      if (!interview || !question || question.revision !== answer.question_revision || user(interview.user_id)?.disabled) throw new Error('stale question');
      await mkdir(jobDir, { recursive: true, mode: 0o700 });
      const allSegments = db.prepare('SELECT * FROM interview_segments WHERE session_id=? AND final=1 ORDER BY start_ms,rowid').all(interview.id).map(segmentView).filter(s=>question.audio_end_ms===null||s.startMs<=question.audio_end_ms);
      const ids = parse(interview.knowledge_ids);
      const files = ids.length ? db.prepare(`SELECT name,text FROM knowledge WHERE user_id=? AND status='ready' AND id IN (${ids.map(() => '?').join(',')})`).all(interview.user_id, ...ids) : [];
      const context = assembleInterviewContext({ style: interview.style_snapshot, question: question.text, segments: allSegments, files, budget: contextBudget });
      const audioTurns=answer.mode==='audio'?await readAudioTurns(interview,question):undefined;
      if(audioTurns)context.prompt+='\n本次直接根据音频回答。每段音频标记远端/本人，最后currentQuestion标记才是当前问题；AI建议不代表本人已说。未转写的较早音频未必进入本次有限上下文，禁止编造。';
      const snapshotId = randomUUID();
      db.prepare('INSERT INTO interview_contexts(id,session_id,question_id,prompt,sources,summary,segment_ids,watermark,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(snapshotId, interview.id, question.id, context.prompt, JSON.stringify(context.sources), context.summary, JSON.stringify(context.segmentIds), context.watermark, now());
      db.prepare("UPDATE interview_answers SET context_snapshot_id=? WHERE id=? AND status='running'").run(snapshotId, answer.id);
      db.prepare("UPDATE interview_questions SET status='answering',updated_at=? WHERE id=? AND revision=?").run(now(), question.id, question.revision); notifyQuestion(question.id); notifyAnswer(answer.id);
      let accumulated = '', lastSave = 0;
      let run=textRunner;if(answer.mode==='audio'){if(audioRunner)run=audioRunner;else run=async input=>{const m=await import('./native-audio-providers.mjs');const current=m.createNativeAudioRunner(accountAi?.api('omni',{...omni,timeoutMs})||{...omni,timeoutMs});try{return await current(input);}finally{await current.close();}};}
      const result = await run({audioTurns,model:answer.model||answer.audio_model||undefined, provider: answer.provider, prompt: context.prompt, jobDir, sessionId: interview.id, userId: interview.user_id, signal: controller.signal, onDelta(delta) {
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
          const messages = { AI_NOT_CONFIGURED: answer.mode==='audio'?'尚未配置音频直答模型，请管理员检查 OMNI 密钥、业务空间、地域和模型权限':'尚未配置该文本模型，请管理员配置百炼文本 API Key 或选择已登录的 Codex / Claude',AI_AUDIO_LIMIT:'音频输入超过模型限制，请缩短本场音频窗口后重试', AI_CLI_NOT_FOUND: '未找到文本模型 CLI，请检查服务账号安装和配置', AI_TIMEOUT: '回答生成超时，可重新提问或调整云端超时设置', AI_EMPTY_OUTPUT: '模型未返回回答，请检查模型服务后重试', AI_OUTPUT_LIMIT: '回答过长已中止，请使用更简洁的回答风格' };
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
    try { while (!closed && active.size < concurrency) { const row = claim(); if (!row) break; const controller = new AbortController(); const promise = execute(row, controller).finally(async () => { active.delete(row.id); const interview = getSession(row.session_id); if (interview?.status === 'ended'){void textRunner.closeSession?.(row.session_id);if(retentionDays===0&&!db.prepare("SELECT id FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").get(interview.id))await audio.removeFiles(interview).catch(()=>{});} setImmediate(() => void pump()); }); active.set(row.id, { controller, promise, sessionId: row.session_id }); } }
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
      const linked = db.prepare("SELECT q.* FROM interview_questions q JOIN interview_question_segments l ON l.question_id=q.id WHERE l.segment_id=? AND q.origin NOT LIKE 'trigger_%'").all(id);
      for (const question of linked) {
        const segmentIds = parse(question.segment_ids), content = segmentIds.map(segmentId => db.prepare('SELECT text FROM interview_segments WHERE id=?').get(segmentId)?.text || '').join('\n');
        db.prepare("UPDATE interview_questions SET text=?,revision=revision+1,status='pending',updated_at=? WHERE id=?").run(content, timestamp, question.id);
        for (const answer of db.prepare("SELECT id FROM interview_answers WHERE question_id=? AND status IN ('queued','running')").all(question.id)) cancelAnswer(answer.id);
        notifyQuestion(question.id);
        if (!closed && !replay && interview.mode==='transcript' && interview.auto_answer && interview.status === 'recording') try { queueAnswer(interview, db.prepare('SELECT * FROM interview_questions WHERE id=?').get(question.id)); } catch {}
      }
      if (!closed && !replay && !linked.length && interview.mode==='transcript' && interview.auto_answer && interview.status === 'recording' && !user(interview.user_id)?.disabled) {
        const pending = auto.get(sessionId) || { ids: [], timer: null };
        if (!pending.ids.includes(id)) pending.ids.push(id);
        if (pending.ids.length > 50) pending.ids.shift();
        clearTimeout(pending.timer); pending.timer = setTimeout(() => flushAuto(sessionId), debounceMs); pending.timer.unref(); auto.set(sessionId, pending);
      }
    }
  }
  const maxDailyMinutes=boundedNumber(options.maxDailyMinutes??process.env.ASR_DAILY_MINUTES,480,1,2880);
  const effectiveAsr=()=>asrConfiguration(accountAi?.api('asr',asr)||asr);
  const effectiveOmni=()=>nativeAudioConfiguration(accountAi?.api('omni',omni)||omni);
  const hasAsr=()=>!!asrFactory||effectiveAsr().configured;
  const hasAudio=()=>!!audioRunner||effectiveOmni().configured;
  const startAsr=asrFactory||(input=>createDashScopeAsrFactory(accountAi?.api('asr',asr)||asr)(input));
  const audio = attachInterviewAudio({ server, db, dataDir, publicOrigin, asrFactory:input=>startAsr({...input,model:getSession(input.sessionId)?.asr_model||asrConfig.model}), recordSegment,onStored:notifyInterview,asrRequested:id=>!!getSession(id)?.transcribe,asrEnabled:id=>{const i=getSession(id);return i&&(i.mode==='transcript'||(i.transcribe&&hasAsr()));},asrRequired:id=>getSession(id)?.mode==='transcript', status: audioStatus, gap, maxSessionMinutes, retentionDays, maxDailyMinutes, maxUserBytes: boundedNumber(options.maxUserAudioBytes ?? process.env.AUDIO_MAX_USER_BYTES, 512*1024*1024, 1024*1024, 2*1024*1024*1024) });
  db.prepare("UPDATE interview_answers SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,lease_until=NULL,updated_at=? WHERE status='running'").run(now());

  // Surviving recordings cannot truthfully remain "recording" after a restart.
  for (const old of db.prepare("SELECT * FROM interviews WHERE status='recording'").all()) { db.prepare("UPDATE interviews SET status='paused',recording_status='interrupted',error='服务器已重启，请恢复录音并补传本地缓存',updated_at=? WHERE id=?").run(now(), old.id); gap(old.id, null, null, null, '服务器重启造成录音中断'); }
  const prepare = interview => { if (interview.mode==='transcript' && textRunner.prepareSession && interview.status === 'recording') void Promise.resolve(textRunner.prepareSession({ userId: interview.user_id, sessionId: interview.id,provider:interview.provider,model:textModelFor(interview)||undefined })).catch(() => { /* A model failure never masquerades as an ASR recording failure. */ }); };
  router.get('/config', (req, res) => res.json({ asrTransport:effectiveAsr().transport,asrChunkSeconds:Number(effectiveAsr().chunkSeconds)||4, configured:hasAsr(), model: asrConfig.model,asrModel:asrConfig.model,asrModels,customAsrModelsAllowed,customAudioModelsAllowed, region: asrConfig.region, sampleRate: 16000, maxSessionMinutes,maxDailyMinutes, rawAudioRetentionDays: retentionDays,audioConfigured:hasAudio(),audioModels,defaults:defaults(req.identity.userId), autoAnswerAvailable: true, providers: ['codex','claude', ...(accountAi?.profile('transcript.bailian').apiKey || process.env.INTERVIEW_TEXT_API_KEY || process.env.DASHSCOPE_API_KEY || asrConfig.apiKey || !lazyRunner ? ['bailian'] : [])], defaultProvider }));
  router.get('/preferences',(req,res)=>res.json({preferences:defaults(req.identity.userId)}));
  router.patch('/preferences',(req,res)=>{if(req.identity.kind!=='web'||req.identity.role!=='admin')fail(403,'仅管理员可配置模型默认设置');const value=validateSettings(req.body,defaults(req.identity.userId));db.transaction(()=>{accountAi?.save({...Object.fromEntries(Object.entries(value.textModels).map(([provider,model])=>['transcript.'+provider,{model}])),asr:{model:value.asrModel},omni:{model:value.audioModel}});db.prepare('INSERT INTO interview_preferences(user_id,value) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value').run(accountAi?.owner() || req.identity.userId,JSON.stringify(value));})();res.json({preferences:value});});
  router.get('/', (req, res) => { const limit = Math.max(1,Math.min(200,parseInt(req.query.limit,10)||50)); res.json({ interviews: db.prepare('SELECT * FROM interviews WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(req.identity.userId, limit).map(interviewView) }); });
  router.post('/', (req, res) => {
    const owner = req.identity.userId, body = req.body;
    const settings=validateSettings(body,defaults(owner),req.identity.role==='admin'&&req.identity.kind==='web');const provider=settings.provider; if (!validProviders.includes(provider)) fail(400, '不支持的面试回答模型');
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
      db.prepare('INSERT INTO interviews(id,user_id,device_id,title,status,provider,prompt_id,prompt_name,style_snapshot,knowledge_ids,hotwords,auto_answer,created_at,updated_at) VALUES(?,?,?,?,\'recording\',?,?,?,?,?,?,?,?,?)').run(id, owner, req.identity.deviceId || null, body.title ? text(body.title,'面试名称',120) : '面试 '+timestamp.slice(0,16).replace('T',' '), provider, prompt?.id || null, prompt?.name || '默认回答风格', prompt?.content || '中文，先给结论再给关键依据，不编造个人经历。', JSON.stringify(files), JSON.stringify(hotwords.map(word => word.trim())), settings.mode==='audio'||body.autoAnswer!==true ? 0 : 1, timestamp, timestamp);
      db.prepare('UPDATE interviews SET mode=?,transcribe=?,audio_model=?,audio_window_seconds=? WHERE id=?').run(settings.mode,settings.mode==='transcript'?1:settings.transcribe?1:0,settings.audioModel,settings.audioWindowSeconds,id);
      db.prepare('UPDATE interviews SET text_models=?,asr_model=? WHERE id=?').run(JSON.stringify(settings.textModels),settings.asrModel,id);
      db.prepare('UPDATE interviews SET model_overrides=? WHERE id=?').run(JSON.stringify(req.identity.role==='admin'&&req.identity.kind==='web'?overridePatch({},body,owner):{}),id);
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
      contextSummary: context ? { ...context, segmentIds: parse(context.segment_ids) } : null,audioAvailable:!!db.prepare('SELECT seq FROM interview_audio_frames WHERE session_id=? AND byte_offset IS NOT NULL LIMIT 1').get(row.id) };
  }
  router.get('/:id', (req, res) => res.json(detail(own(req.params.id,req.identity.userId), { cursor:req.query.cursor,beforeStartMs: req.query.beforeStartMs === undefined ? undefined : Number(req.query.beforeStartMs) })));
  router.patch('/:id', (req, res) => {
    const row = own(req.params.id,req.identity.userId), body = req.body;
    if (body.autoAnswer !== undefined && typeof body.autoAnswer !== 'boolean') fail(400, '自动回答设置无效');
    if (body.provider !== undefined && !validProviders.includes(body.provider)) fail(400, '不支持的面试回答模型');
    const previous={mode:row.mode,provider:row.provider,textModels:modelMap(parse(row.text_models,{})),textModelSources:Object.fromEntries(validProviders.map(p=>[p,parse(row.model_overrides,{}).textModels?.[p]?'本场显式覆盖':defaults(row.user_id).textModels?.[p]?'管理员网页配置':'服务器默认'])),asrModel:row.asr_model||asrConfig.model,transcribe:!!row.transcribe,audioModel:row.audio_model,audioWindowSeconds:row.audio_window_seconds};
    const settings=validateSettings(body,previous,req.identity.role==='admin'&&req.identity.kind==='web');
    const changes=['mode','provider','transcribe','audioModel','audioWindowSeconds','textModels','asrModel'].some(key=>body[key]!==undefined&&JSON.stringify(settings[key])!==JSON.stringify(previous[key]));
    if(changes&&row.status==='recording')fail(409,'请先暂停录音再切换回答模式或音频配置');
    if(changes||body.provider!==undefined)db.prepare('UPDATE interviews SET config_version=config_version+1 WHERE id=?').run(row.id);
    if(changes){for(const a of db.prepare("SELECT id FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").all(row.id))cancelAnswer(a.id);stopAuto(row.id);}
    if (settings.provider !== row.provider) { for (const answer of db.prepare("SELECT id FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").all(row.id)) cancelAnswer(answer.id); void textRunner.closeSession?.(row.id); }
    db.prepare('UPDATE interviews SET title=?,auto_answer=?,provider=?,updated_at=? WHERE id=?').run(body.title === undefined ? row.title : text(body.title,'面试名称',120), body.autoAnswer === undefined ? row.auto_answer : body.autoAnswer ? 1 : 0, settings.provider, now(), row.id);
    db.prepare('UPDATE interviews SET mode=?,transcribe=?,audio_model=?,audio_window_seconds=?,auto_answer=? WHERE id=?').run(settings.mode,settings.mode==='transcript'?1:settings.transcribe?1:0,settings.audioModel,settings.audioWindowSeconds,settings.mode==='audio'?0:body.autoAnswer===undefined?row.auto_answer:body.autoAnswer?1:0,row.id);
    db.prepare('UPDATE interviews SET text_models=?,asr_model=? WHERE id=?').run(JSON.stringify(settings.textModels),settings.asrModel,row.id);
    if(req.identity.role==='admin'&&req.identity.kind==='web')db.prepare('UPDATE interviews SET model_overrides=? WHERE id=?').run(JSON.stringify(overridePatch(parse(row.model_overrides,{}),body,row.user_id,parse(row.text_models,{}))),row.id);
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
      if (!db.prepare("SELECT id FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").get(row.id)){await textRunner.closeSession?.(row.id);if(action==='end'&&retentionDays===0)await audio.removeFiles(row);}
    }
    notifyInterview(row.id); return getSession(row.id);
  }
  for (const action of ['pause','resume','end']) router.post(`/:id/${action}`, route(async (req,res) => res.json({ interview: interviewView(await transition(own(req.params.id,req.identity.userId), action)) })));
  router.post('/:id/audio-ticket', (req,res) => {
    const row = own(req.params.id,req.identity.userId);
    if (req.identity.kind !== 'device') fail(403, '请从已配对的 Windows 客户端开始录音');
    if (row.mode==='transcript'&&!hasAsr()) fail(503, '尚未配置实时语音识别，请管理员设置百炼 API Key、业务空间和地域', 'ASR_NOT_CONFIGURED');
    if(row.mode==='audio'&&!hasAudio())fail(503,'尚未配置音频直答模型，请管理员配置 OMNI 或百炼密钥','AUDIO_NOT_CONFIGURED');
    const mode = req.body.mode || 'live'; if (!['live','replay'].includes(mode)) fail(400, '音频传输模式无效');
    if (mode === 'live' && row.status !== 'recording') fail(409, '请先恢复面试录音');
    if (row.device_id && row.device_id !== req.identity.deviceId) fail(403, '本场面试已由另一台电脑录音');
    if (!row.device_id) { if (mode === 'replay' && row.status === 'ended') fail(403,'结束后的录音只能由原设备回补'); db.prepare('UPDATE interviews SET device_id=?,updated_at=? WHERE id=?').run(req.identity.deviceId,now(),row.id); }
    const ticket = randomToken(), expiresAt = new Date(Date.now()+30000).toISOString();
    db.prepare('INSERT INTO interview_audio_tickets(token_hash,session_id,user_id,device_id,mode,expires_at) VALUES(?,?,?,?,?,?)').run(hash(ticket),row.id,row.user_id,req.identity.deviceId,mode,expiresAt);
    res.json({ ticket, path:'/audio?ticket='+encodeURIComponent(ticket), expiresAt });
  });
  const triggerChains=new Map(),triggerDepths=new Map();
  function revalidateTriggerIdentity(req,interview){
    const identity=req.identity,account=user(identity.userId);
    if(!account||account.disabled)fail(401,'账号状态已变化，请重新登录');
    if(identity.kind==='device'){
      if(!db.prepare('SELECT id FROM devices WHERE id=? AND user_id=?').get(identity.deviceId,identity.userId))fail(401,'设备配对已撤销，请重新配对');
      if(interview&&interview.device_id!==identity.deviceId)fail(403,'录音设备已变化，请使用当前录音设备');
    }else if(!db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?').get(identity.tokenHash,identity.userId,now()))fail(401,'登录状态已变化，请重新登录');
  }

  async function trigger(req){
    const sessionId=req.params.id,requestId=req.body.requestId;
    if(typeof requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))fail(400,'触发请求编号无效');
    if(closed)fail(503,'服务正在停止，请稍后重试');revalidateTriggerIdentity(req);
    let interview=own(sessionId,req.identity.userId);revalidateTriggerIdentity(req,interview);const configVersion=interview.config_version;
    if(req.identity.kind==='device'&&interview.device_id!==req.identity.deviceId)fail(403,'请使用本场面试的录音设备触发回答');
    const same=db.prepare('SELECT * FROM interview_triggers WHERE session_id=? AND request_id=?').get(sessionId,requestId);
    const resultFor=t=>({question:questionView(db.prepare('SELECT * FROM interview_questions WHERE id=?').get(t.question_id)),answer:answerView(db.prepare('SELECT * FROM interview_answers WHERE id=?').get(t.answer_id))});
    if(same)return resultFor(same);
    const recent=db.prepare('SELECT * FROM interview_triggers WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(sessionId);
    if(recent&&recent.config_version===interview.config_version&&Date.now()-Date.parse(recent.created_at)<600)return resultFor(recent);
    if(req.body.historyTrack!==undefined&&!['remote','self'].includes(req.body.historyTrack))fail(400,'历史提问来源无效');
    if(req.body.historyTrack)return historyAnswer(req.body.historyTrack);
    if(interview.mode==='transcript'&&interview.status!=='recording'){
      const selected=historySource();if(selected)return historyAnswer(selected);
    }
    if(!['recording','paused'].includes(interview.status))fail(409,'本场会话没有可回答的历史转写，请选择已有问题或手动输入问题');
    let last=db.prepare("SELECT * FROM interview_questions WHERE session_id=? AND origin=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(sessionId,'trigger_'+interview.mode);
    let rangeStart,rangeEnd,captureEndMs,selectedSegments=[],truncated=false,questionText;
    if(interview.mode==='audio'){
      if(!hasAudio())fail(503,'音频直答模型尚未配置','AUDIO_NOT_CONFIGURED');
      const latest=db.prepare("SELECT max(start_ms+sample_count/16) AS end FROM interview_audio_frames WHERE session_id=? AND track='remote' AND replay=0 AND active=1 AND byte_offset IS NOT NULL").get(sessionId).end;
      if(latest===null)fail(409,'尚未收到有效的远端声音，请等面试官提问后再触发');
      if(last&&latest<=last.audio_end_ms)return remember(last,queueAnswer(interview,last));
      rangeEnd=latest;captureEndMs=latest;const earliest=db.prepare("SELECT min(start_ms) AS start FROM interview_audio_frames WHERE session_id=? AND track='remote' AND replay=0 AND active=1 AND start_ms+sample_count/16>?").get(sessionId,last?.audio_end_ms||0).start;
      rangeStart=Math.max(0,last?.audio_end_ms||0,rangeEnd-interview.audio_window_seconds*1000,earliest-300);truncated=earliest<rangeStart;
      const time=value=>`${Math.floor(value/60000).toString().padStart(2,'0')}:${Math.floor(value/1000%60).toString().padStart(2,'0')}`;
      questionText=`音频提问 ${time(rangeStart)}–${time(rangeEnd)}`;
    }else{
      if(interview.status==='recording'&&effectiveAsr().transport==='http') {
        let timer;
        try { await Promise.race([audio.flushSession(sessionId),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('分段语音仍在识别，请稍后再次触发回答'),{status:409})),12000);})]); }
        catch(error){const selected=historySource();if(selected)return historyAnswer(selected);throw error;}
        finally {clearTimeout(timer);}
        const current=getSession(sessionId);revalidateTriggerIdentity(req,current);
        if(!current||current.config_version!==configVersion)fail(409,'回答模式或配置已变化，请重新触发');
      }
      if(historySource()==='self')return historyAnswer('self');
      const tracks=db.prepare('SELECT track FROM interview_audio_frames WHERE session_id=? AND replay=0 AND active=1 GROUP BY track').all(sessionId).map(row=>row.track);
      if(!tracks.includes('remote')&&tracks.includes('self'))fail(409,'目前只录到了本人麦克风，尚未发现明确提问。请说出希望 AI 回答的问题，或手动输入问题');
      const deadline=Date.now()+boundedNumber(options.triggerTranscriptWaitMs,1200,20,2000);
      const latestVoice=db.prepare("SELECT max(start_ms+sample_count/16) AS end FROM interview_audio_frames WHERE session_id=? AND track='remote' AND replay=0 AND active=1").get(sessionId).end;
      const waitingForAudio=latestVoice!==null&&latestVoice>(last?.capture_end_ms??last?.audio_end_ms??-1);
      let segments;
      do{
        segments=db.prepare("SELECT * FROM interview_segments WHERE session_id=? AND track='remote' AND replay=0 AND start_ms>? ORDER BY start_ms,rowid").all(sessionId,last?.trigger_watermark??-1);
        const caughtUp=segments.length&&Math.max(...segments.map(s=>s.end_ms??s.start_ms))>=latestVoice-100;
        if(segments.length&&segments.every(s=>s.final)&&(!waitingForAudio||caughtUp))break;
        if(Date.now()>=deadline||(!waitingForAudio&&!segments.some(s=>!s.final)))break;
        await new Promise(r=>setTimeout(r,40));const current=getSession(sessionId);revalidateTriggerIdentity(req,current);if(!current||current.config_version!==configVersion)fail(409,'回答模式或配置已变化，请重新触发');
      }while(true);
      interview=own(sessionId,req.identity.userId);revalidateTriggerIdentity(req,interview);if(closed)fail(503,'服务正在停止，请稍后重试');if(!['recording','paused'].includes(interview.status))fail(409,'会话状态已变化，请重试');
      if(!segments.length){
        if(last&&!waitingForAudio){
          const ids=parse(last.segment_ids);const updated=ids.length?db.prepare(`SELECT * FROM interview_segments WHERE session_id=? AND id IN (${ids.map(()=>'?').join(',')}) ORDER BY start_ms,rowid`).all(sessionId,...ids):[];
          if(updated.length){const finalText=(updated.some(s=>!s.final)?'[包含尚未定稿的转写]\n':'')+updated.map(s=>s.text).join('\n');if(finalText!==last.text){db.prepare('UPDATE interview_questions SET text=?,revision=revision+1,audio_end_ms=?,updated_at=? WHERE id=?').run(finalText,Math.max(last.audio_end_ms||0,...updated.map(s=>s.end_ms??s.start_ms)),now(),last.id);last=db.prepare('SELECT * FROM interview_questions WHERE id=?').get(last.id);}}
          notifyQuestion(last.id);return remember(last,queueAnswer(interview,last));
        }
        fail(409,'新音频正在转写，请稍后再按快捷键，或手动输入问题');
      }
      rangeEnd=Math.max(...segments.map(s=>s.end_ms??s.start_ms));rangeStart=Math.max(segments[0].start_ms,rangeEnd-interview.audio_window_seconds*1000);truncated=segments[0].start_ms<rangeStart;segments=segments.filter(s=>(s.end_ms??s.start_ms)>=rangeStart);
      selectedSegments=segments.map(s=>s.id);captureEndMs=latestVoice??rangeEnd;questionText=segments.map(s=>s.text).join('\n');if(segments.some(s=>!s.final))questionText='[包含尚未定稿的转写]\n'+questionText;
    }
    const created=createQuestion(interview,{text:questionText},'trigger_'+interview.mode);
    db.prepare('UPDATE interview_questions SET capture_end_ms=?,segment_ids=?,audio_start_ms=?,audio_end_ms=?,audio_truncated=?,trigger_watermark=? WHERE id=?').run(captureEndMs,JSON.stringify(selectedSegments),rangeStart,rangeEnd,truncated?1:0,interview.mode==='transcript'?Math.max(...db.prepare("SELECT start_ms FROM interview_segments WHERE session_id=? AND track='remote' AND replay=0 AND start_ms<=?").all(sessionId,rangeEnd).map(s=>s.start_ms)):rangeEnd,created.question.id);
    notifyQuestion(created.question.id);
    return remember(db.prepare('SELECT * FROM interview_questions WHERE id=?').get(created.question.id),created.answer);
    function historySource(){
      const remote=db.prepare("SELECT start_ms FROM interview_segments WHERE session_id=? AND track='remote' AND final=1 ORDER BY start_ms DESC LIMIT 1").get(sessionId);
      const self=db.prepare("SELECT text,start_ms FROM interview_segments WHERE session_id=? AND track='self' AND final=1 ORDER BY start_ms DESC LIMIT 50").all(sessionId);
      const question=self.find(row=>isQuestion(row.text));
      if(question&&(!remote||question.start_ms>remote.start_ms))return 'self';
      return remote?'remote':null;
    }
    function historyAnswer(track){
      let rows=db.prepare('SELECT * FROM interview_segments WHERE session_id=? AND track=? AND final=1 ORDER BY start_ms DESC,rowid DESC LIMIT 50').all(sessionId,track).reverse();
      if(!rows.length)fail(409,'该音轨尚无已保存的转写，请先录音或手动输入问题');
      const latest=rows.at(-1).end_ms??rows.at(-1).start_ms;
      rows=rows.filter(row=>(row.end_ms??row.start_ms)>=latest-120000);
      if(track==='self'&&req.body.historyTrack!=='self'){
        const index=rows.findLastIndex(row=>isQuestion(row.text));
        if(index<0)fail(409,'本人历史转写中尚未发现明确提问，请手动输入希望 AI 回答的问题');
        rows=rows.slice(index);
      }
      const label=track==='self'?'本人麦克风中的明确提问（用户主动触发回答）':'远端历史提问';
      const questionText=`【${label}】\n`+rows.map(row=>row.text).join('\n').slice(-7800);
      const created=createQuestion(interview,{text:questionText},'history_'+track);
      db.prepare('UPDATE interview_questions SET segment_ids=?,audio_start_ms=?,audio_end_ms=? WHERE id=?').run(JSON.stringify(rows.map(row=>row.id)),rows[0].start_ms,latest,created.question.id);
      for(const row of rows)db.prepare('INSERT OR IGNORE INTO interview_question_segments(question_id,segment_id) VALUES(?,?)').run(created.question.id,row.id);
      notifyQuestion(created.question.id);
      return remember(db.prepare('SELECT * FROM interview_questions WHERE id=?').get(created.question.id),created.answer);
    }
    function remember(question,answer){db.prepare('INSERT INTO interview_triggers(session_id,request_id,question_id,answer_id,created_at,config_version) VALUES(?,?,?,?,?,?)').run(sessionId,requestId,question.id,answer.id,now(),interview.config_version);return {question:questionView(question),answer:answerView(answer)};}
  }
  router.post('/:id/trigger',route(async(req,res)=>{
    // Resolve ownership before entering a per-session serialized, bounded trigger queue.
    const id=req.params.id;own(id,req.identity.userId);const depth=triggerDepths.get(id)||0;if(depth>=4)fail(429,'触发请求正在处理中，请稍后再按快捷键');triggerDepths.set(id,depth+1);const prior=triggerChains.get(id)||Promise.resolve();const next=prior.catch(()=>{}).then(()=>trigger(req));triggerChains.set(id,next);event(id,{type:'interview.trigger.status',status:'processing'});try{const result=await next;event(id,{type:'interview.trigger.status',status:'queued'});res.status(201).json(result);}catch(error){event(id,{type:'interview.trigger.status',status:'failed',error:error.status&&error.status<500?error.message:'回答触发失败，请检查语音连接和服务端配置'});throw error;}finally{const remaining=(triggerDepths.get(id)||1)-1;if(remaining)triggerDepths.set(id,remaining);else triggerDepths.delete(id);if(triggerChains.get(id)===next)triggerChains.delete(id);}
  }));
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
    const lines=[`# ${row.title}`,`回答模式：${row.mode==='audio'?'音频直答':'转写后回答'}`,`后台转写：${row.transcribe?'开启':'关闭；原始音频按保留策略保存，没有逐字记录'}`,`开始：${row.created_at}`,`结束：${row.ended_at||'未结束'}`,'','## 实际对话（远端 / 本人）',''];
    for(const s of data.segments)lines.push(`**${(s.startMs/1000).toFixed(1)}s ${s.track==='self'?'本人':'远端'}${s.final?'':'（临时识别）'}**`,s.text,'');
    lines.push('## AI 建议（不代表本人实际说过）','');for(const answer of data.answers){const q=data.questions.find(x=>x.id===answer.questionId);lines.push(`### ${q?.text||'问题'}（问题版本 ${answer.questionRevision}）`,`状态：${answer.status}；模式：${answer.mode}；执行方式：${answer.provider}；模型：${answer.model||answer.audioModel||'CLI默认模型'}`,q?.audioRange?`音频范围：${q.audioRange.startMs}–${q.audioRange.endMs}ms${q.audioTruncated?'（已按窗口截断）':''}`:'',answer.text||answer.error||'尚无回答','');}
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
    const expired=db.prepare("SELECT DISTINCT i.* FROM interviews i JOIN interview_audio_frames f ON f.session_id=i.id WHERE i.status<>'recording' AND (?<>0 OR i.status='ended') AND COALESCE(i.ended_at,i.updated_at)<? AND f.byte_offset IS NOT NULL").all(retentionDays,cutoff);
    for(const row of expired)if(![...active.values()].some(a=>a.sessionId===row.id)&&!db.prepare("SELECT id FROM interview_answers WHERE session_id=? AND status IN ('queued','running')").get(row.id))await audio.removeFiles(row);
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
    async close(){if(closed)return;closed=true;clearInterval(timer);clearInterval(maintenance);for(const id of auto.keys())stopAuto(id);for(const item of active.values())item.controller.abort(Object.assign(new Error('shutdown'),{code:'SHUTDOWN'}));await maintenanceTask;await Promise.allSettled([...triggerChains.values()]);await audio.close();await Promise.all([...active.values()].map(a=>a.promise));for(const row of db.prepare("SELECT * FROM interviews WHERE status='recording'").all()){db.prepare("UPDATE interviews SET status='paused',recording_status='interrupted',error='服务器停止，录音已暂停',updated_at=? WHERE id=?").run(now(),row.id);}await textRunner.close?.();await audioRunner?.close?.();}
  };
}
