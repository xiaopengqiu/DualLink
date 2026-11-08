import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/db.mjs';

function waitFor(fn, timeout = 3000) { return new Promise((resolve, reject) => { const begin = Date.now(); const run = () => { let value; try { value = fn(); } catch (e) { reject(e); return; } if (value) resolve(value); else if (Date.now() - begin > timeout) reject(new Error('condition timeout')); else setTimeout(run, 10); }; run(); }); }
function next(socket, type) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error('missing '+type)); }, 4000); const message = bytes => { const e = JSON.parse(bytes.toString()); if (e.type === type) { cleanup(); resolve(e); } }; const close = () => { cleanup(); reject(new Error('socket closed before '+type)); }; function cleanup() { clearTimeout(timer); socket.off('message', message); socket.off('close', close); } socket.on('message', message); socket.on('close', close); }); }
function frame(track = 0, seq = 0, start = 0, replay = false) { const buffer = Buffer.alloc(3216); buffer[0] = 1; buffer[1] = track; buffer.writeUInt16BE(replay ? 1 : 0, 2); buffer.writeUInt32BE(seq, 4); buffer.writeUInt32BE(start, 8); buffer.writeUInt32BE(1600, 12); return buffer; }

test('scenario models select ASR per session and text model per provider while preserving queued snapshots',async t=>{
  const calls=[];const s=await setup(t,{textRunner:async input=>{calls.push(input);return {answer:'fast answer'};}});const a=await s.login(),b=await s.login('b@example.com'),device=await s.pair(a);
  const prefs={textModels:{codex:'codex-fast',claude:'qwen-flash',bailian:'qwen-flash'},asrModel:'qwen-audio-3.0-asr-flash-streaming',provider:'claude'};
  assert.equal((await s.api('/interviews/preferences',a,'PATCH',prefs)).status,200);
  assert.equal((await (await s.api('/interviews/preferences',b)).json()).preferences.textModels.claude,'qwen-flash');
  const interview=await s.create(device);assert.deepEqual(interview.textModels,prefs.textModels);assert.equal(interview.asrModel,prefs.asrModel);
  const {socket}=await s.audio(interview,device);assert.equal(s.asrTasks[0].model,prefs.asrModel);
  assert.equal((await s.api(`/interviews/${interview.id}`,a,'PATCH',{textModels:{claude:'different-fast'}})).status,409);
  assert.equal((await s.api(`/interviews/${interview.id}`,a,'PATCH',{provider:'codex'})).status,409);
  assert.equal((await s.api(`/interviews/${interview.id}/questions`,a,'POST',{text:'请解释缓存'})).status,201);
  await waitFor(()=>calls.length);assert.equal(calls[0].provider,'claude');assert.equal(calls[0].model,'qwen-flash');
  const detail=await (await s.api(`/interviews/${interview.id}`,a)).json();assert.equal(detail.answers[0].model,'qwen-flash');
  assert.equal((await s.api(`/interviews/${interview.id}/pause`,a,'POST',{})).status,200);
  const changed=await s.api(`/interviews/${interview.id}`,a,'PATCH',{provider:'codex',textModels:{claude:'different-fast'},asrModel:'qwen-audio-3.1-asr-flash-streaming'});assert.equal(changed.status,200);
  const newView=(await changed.json()).interview;assert.equal(newView.provider,'codex');assert.equal(newView.textModels.codex,'codex-fast');assert.equal(newView.textModels.claude,'different-fast');
  socket.close();
});

test('empty audio model selection resolves the server default for preferences and paused sessions',async t=>{
  const s=await setup(t,{omni:{model:'qwen3.8-omni-flash-realtime',models:['qwen3.8-omni-flash-realtime']}});const a=await s.login();
  const saved=await s.api('/interviews/preferences',a,'PATCH',{audioModel:''});assert.equal(saved.status,200);assert.equal((await saved.json()).preferences.audioModel,'qwen3.8-omni-flash-realtime');
  const interview=await s.create(a);await s.api(`/interviews/${interview.id}/pause`,a,'POST',{});
  const changed=await s.api(`/interviews/${interview.id}`,a,'PATCH',{audioModel:''});assert.equal(changed.status,200);assert.equal((await changed.json()).interview.audioModel,'qwen3.8-omni-flash-realtime');
});

async function setup(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dual-interviews-'));
  const asrTasks = [], prompts = [], extraServices=[];
  const service = await createApp({ dataDir, secureCookies: false, startWorker: false,
    asrFactory: async options => { const task = { ...options, frames: [], async write(pcm, startMs) { task.frames.push({ pcm, startMs }); }, async finish() { task.finished = true; }, close() { task.closed = true; } }; asrTasks.push(task); return task; },
    textRunner: async input => { prompts.push(input.prompt); input.onDelta?.('建议'); return { answer: '建议：AI_ONLY_PRIVATE_SUGGESTION', usage: { output_tokens: 7 } }; },
    interviews: { debounceMs: 40 }, ...overrides });
  await new Promise(r => service.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${service.server.address().port}`;
  t.after(async () => { for(const extra of extraServices)await extra.close();await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  service.createUser({ email: 'a@example.com', password: 'correct-password-123', role: 'admin' });
  service.createUser({ email: 'b@example.com', password: 'correct-password-123' });
  async function api(route, auth, method = 'GET', body) { const multipart = body instanceof FormData; return fetch(url + '/api'+route, { method, headers: { ...auth?.headers, ...(!multipart && body ? { 'content-type': 'application/json' } : {}) }, body: body ? multipart ? body : JSON.stringify(body) : undefined }); }
  async function login(email = 'a@example.com') { const r = await api('/auth/login', null, 'POST', { email, password: 'correct-password-123' }); assert.equal(r.status, 200); const b = await r.json(); return { ...b, headers: { cookie: r.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': b.csrfToken } }; }
  async function pair(auth) { const secret = randomBytes(32).toString('hex'); const p = await (await api('/pairings', null, 'POST', { name: 'Interview PC', deviceSecret: secret })).json(); const approved = await api('/pairings/approve', auth, 'POST', { code: p.code }); assert.equal(approved.status, 200); return { headers: { Authorization: 'Bearer '+secret }, device: (await approved.json()).device }; }
  async function create(auth, body = {}) { const r = await api('/interviews', auth, 'POST', { title: '技术面试', ...body }); assert.equal(r.status, 201); return (await r.json()).interview; }
  async function audio(interview, device, mode = 'live') { const response = await api(`/interviews/${interview.id}/audio-ticket`, device, 'POST', { mode }); assert.equal(response.status, 200); const ticket = await response.json(); const socket = new WebSocket(url.replace('http:', 'ws:')+ticket.path); await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); const ready = next(socket, 'audio.ready'); socket.send(JSON.stringify({ type: 'audio.start', sampleRate: 16000, format: 'pcm_s16le', tracks: ['remote','self'] })); await ready; return { socket, ticket }; }
  async function restart(options={}){const port=service.server.address().port;await service.close();options.beforeOpen?.();const nextApp=await createApp({dataDir,secureCookies:false,startWorker:false,textRunner:async()=>({answer:'recovered answer'}),...options});extraServices.push(nextApp);await new Promise(r=>nextApp.server.listen(port,'127.0.0.1',r));return nextApp;}
  return { ...service, url, asrTasks, prompts, api, login, pair, create, audio, restart };
}

test('interview sessions are tenant-owned, single-active and expose missing ASR configuration honestly', async t => {
  const s = await setup(t, { asrFactory: undefined, asr: { apiKey: '', workspaceId: '', wsUrl: '' } });
  const a = await s.login(), b = await s.login('b@example.com'), device = await s.pair(a);
  const config = await (await s.api('/interviews/config', a)).json(); assert.equal(config.configured, false);
  const interview = await s.create(a);
  assert.equal((await s.api(`/interviews/${interview.id}`, b)).status, 404);
  assert.equal((await s.api('/interviews', a, 'POST', { title: 'second active' })).status, 409);
  assert.equal((await s.api(`/interviews/${interview.id}/audio-ticket`, device, 'POST', {})).status, 503);
  const manual = await s.api(`/interviews/${interview.id}/questions`, a, 'POST', { text: '介绍一下项目' }); assert.equal(manual.status, 201);
  await waitFor(() => s.db.prepare("SELECT id FROM interview_answers WHERE status='completed'").get());
});

test('dual-track audio uses one-use device tickets, upserts revisions and persists private audio with dedup', async t => {
  const s = await setup(t); const a = await s.login(), b = await s.login('b@example.com'), device = await s.pair(a);
  const interview = await s.create(device, { autoAnswer: false });
  assert.equal((await s.api(`/interviews/${interview.id}/audio-ticket`, a, 'POST', {})).status, 403);
  const { socket, ticket } = await s.audio(interview, device);
  const rejected = new WebSocket(s.url.replace('http:', 'ws:')+ticket.path); const rejectedResult = await new Promise(resolve => { rejected.on('error', () => resolve('rejected')); rejected.on('open', () => resolve('accepted')); }); assert.equal(rejectedResult, 'rejected');
  for (let i = 0; i < 2; i++) { const ack = next(socket, 'audio.ack'); socket.send(frame()); await ack; }
  assert.equal(s.asrTasks[0].frames.length, 1);
  const remote = s.asrTasks.find(task => task.track === 'remote');
  remote.onResult({ segmentId: '1', text: '介绍一下', startMs: 0, endMs: null, final: false });
  remote.onResult({ segmentId: '1', text: '介绍一下 Redis', startMs: 0, endMs: 100, final: true });
  const self = s.asrTasks.find(task => task.track === 'self'); self.onResult({ segmentId: '1', text: '我使用了持久化', startMs: 150, endMs: 500, final: true });
  const detail = await (await s.api(`/interviews/${interview.id}`, a)).json();
  assert.equal(detail.segments.length, 2); assert.equal(detail.segments.find(x => x.track === 'remote').revision, 2);
  assert.equal(detail.segments.find(x => x.track === 'self').text, '我使用了持久化');
  assert.equal((await s.api(`/interviews/${interview.id}/audio/remote`, b)).status, 404);
  const raw = await s.api(`/interviews/${interview.id}/audio/remote`, a); assert.equal(raw.status, 200); assert.equal(Buffer.from(await raw.arrayBuffer()).subarray(0,4).toString(), 'RIFF');
  const stopped = next(socket, 'audio.stopped'); socket.send(JSON.stringify({ type: 'audio.stop' })); await stopped; socket.close();
});

test('auto questions merge final remote sentences and context keeps actual history separate from AI suggestions', async t => {
  const s = await setup(t); const a = await s.login(), device = await s.pair(a);
  const file = new FormData(); file.append('file', new Blob(['青竹项目通过 Redis 保存会话状态。']), 'project.md'); assert.equal((await s.api('/knowledge', a, 'POST', file)).status, 201);
  const interview = await s.create(device,{autoAnswer:true});
  const { socket } = await s.audio(interview, device); const remote = s.asrTasks[0], self = s.asrTasks[1];
  self.onResult({ segmentId: '1', text: '我在青竹项目实际做了断线恢复。', startMs: 0, endMs: 100, final: true });
  remote.onResult({ segmentId: '1', text: '请介绍一下 Redis', startMs: 200, endMs: 300, final: true });
  remote.onResult({ segmentId: '2', text: '以及它的持久化方式？', startMs: 301, endMs: 500, final: true });
  await waitFor(() => s.db.prepare("SELECT id FROM interview_answers WHERE status='completed'").get());
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_questions').get().n, 1);
  assert.match(s.prompts[0], /实际做了断线恢复/); assert.match(s.prompts[0], /保存会话状态/); assert.match(s.prompts[0], /持久化方式/);
  const response = await s.api(`/interviews/${interview.id}/questions`, a, 'POST', { text: '刚才那个项目为什么使用 Redis？' }); assert.equal(response.status, 201);
  await waitFor(() => s.prompts.length === 2);
  assert.doesNotMatch(s.prompts[1], /AI_ONLY_PRIVATE_SUGGESTION/);
  const exported = await s.api(`/interviews/${interview.id}/export?format=json`, a); const result = await exported.json(); assert.equal(result.segments.length, 3); assert.ok(result.answers.length >= 1);
  const markdown = await (await s.api(`/interviews/${interview.id}/export?format=md`, a)).text(); assert.match(markdown, /本人/); assert.match(markdown, /AI 建议/);
  socket.close();
});

test('pause/end drain ASR tails and replay fills old history without generating old questions', async t => {
  const s = await setup(t); const a = await s.login(), device = await s.pair(a); const interview = await s.create(device,{autoAnswer:true});
  const { socket } = await s.audio(interview, device);
  s.asrTasks[0].finish = async () => s.asrTasks[0].onResult({ segmentId: 'tail', text: '请解释缓存。', startMs: 0, endMs: 100, final: true });
  const end = await s.api(`/interviews/${interview.id}/end`, a, 'POST', {}); assert.equal(end.status, 200);
  const detail = await (await s.api(`/interviews/${interview.id}`, a)).json(); assert.equal(detail.interview.status, 'ended'); assert.ok(detail.segments.some(x => x.segmentId.includes('tail')));
  const before = s.db.prepare('SELECT count(*) AS n FROM interview_questions').get().n;
  const replay = await s.audio(interview, device, 'replay'); const replayTask = s.asrTasks.at(-2);
  replayTask.onResult({ segmentId: 'old', text: '你为什么使用队列？', startMs: 5000, endMs: 6000, final: true });
  const ack = next(replay.socket, 'audio.ack'); replay.socket.send(frame(0, 4, 5000, true)); await ack;
  await new Promise(r => setTimeout(r, 100));
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_questions').get().n, before);
  assert.equal((await s.api(`/interviews/${interview.id}/audio-ticket`, device, 'POST', { mode: 'live' })).status, 409);
  replay.socket.close(); socket.close();
});

test('device revocation closes recording immediately and preserves owned historical transcript', async t => {
  const s = await setup(t); const a = await s.login(), device = await s.pair(a), interview = await s.create(device);
  const { socket } = await s.audio(interview, device); s.asrTasks[0].onResult({ segmentId: '1', text: '历史问题', startMs: 0, endMs: 100, final: true });
  const closed = new Promise(resolve => socket.once('close', resolve)); assert.equal((await s.api(`/devices/${device.device.id}`, a, 'DELETE')).status, 200); await closed;
  const detail = await (await s.api(`/interviews/${interview.id}`, a)).json(); assert.equal(detail.segments.length, 1); assert.equal(detail.interview.status, 'paused');
  assert.equal((await s.api(`/interviews/${interview.id}/audio-ticket`, device, 'POST', {})).status, 401);
});

test('malformed audio frame is rejected and cannot grow a recording', async t => {
  const s = await setup(t); const a = await s.login(), device = await s.pair(a), interview = await s.create(device, { autoAnswer: false });
  const { socket } = await s.audio(interview, device); const closed = new Promise(resolve => socket.once('close', resolve)); const bad = frame(); bad.writeUInt32BE(4000, 12); socket.send(bad); await closed;
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_audio_frames').get().n, 0);
});

test('newer questions and final revisions cancel obsolete model work and retain versioned context', async t => {
  const calls = [];
  const runner = async input => { calls.push(input); if (calls.length === 1) await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once:true })); return { answer:'answer '+calls.length }; };
  const s=await setup(t,{textRunner:runner}); const a=await s.login(),device=await s.pair(a),interview=await s.create(device,{autoAnswer:true});
  s.interviews.recordSegment(interview.id,'remote','versioned',{text:'解释 Redis 是什么？',startMs:0,endMs:100,final:true},false);
  await waitFor(()=>calls.length===1);
  s.interviews.recordSegment(interview.id,'remote','versioned',{text:'解释 Redis 持久化方式是什么？',startMs:0,endMs:120,final:true},false);
  await waitFor(()=>s.db.prepare("SELECT id FROM interview_answers WHERE status='completed'").get());
  assert.equal(calls[0].signal.aborted,true);assert.equal(calls.length,2);
  const detail=await(await s.api(`/interviews/${interview.id}`,a)).json();
  assert.equal(detail.questions.length,1);assert.equal(detail.questions[0].revision,2);
  assert.deepEqual(detail.answers.map(x=>x.status),['cancelled','completed']);
  assert.equal(detail.answers[1].contextSummary.segmentIds.length,1);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_segment_revisions').get().n,2);
  const newer=await s.api(`/interviews/${interview.id}/questions`,a,'POST',{text:'继续解释它的缺点'});assert.equal(newer.status,201);
  await waitFor(()=>calls.length===3);
});

test('replay can resend a persisted frame after an uncertain ACK without duplicating storage', async t => {
  const s=await setup(t);const a=await s.login(),device=await s.pair(a),interview=await s.create(device,{autoAnswer:false});
  const live=await s.audio(interview,device);let ack=next(live.socket,'audio.ack');live.socket.send(frame());await ack;
  const stopped=next(live.socket,'audio.stopped');live.socket.send(JSON.stringify({type:'audio.stop'}));await stopped;
  const replay=await s.audio(interview,device,'replay');ack=next(replay.socket,'audio.ack');replay.socket.send(frame(0,0,0,true));await ack;
  assert.equal(s.asrTasks[2].frames.length,1);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_audio_frames').get().n,1);
});

test('zero retention keeps temporary working PCM until end and quota fails explicitly', async t => {
  const s=await setup(t,{interviews:{rawAudioRetentionDays:0,maxDailyMinutes:1}});const a=await s.login(),device=await s.pair(a),interview=await s.create(device,{autoAnswer:false});
  const live=await s.audio(interview,device);const ack=next(live.socket,'audio.ack');live.socket.send(frame());await ack;
  const ledger=s.db.prepare('SELECT * FROM interview_audio_frames').get();assert.equal(ledger.byte_offset,0);
  assert.equal((await stat(path.join(s.dataDir,'users',a.user.id,'interviews',interview.id,'remote.pcm'))).size,3200);
  s.db.prepare('UPDATE interview_audio_usage SET samples=?').run(16000*60);
  const error=next(live.socket,'audio.error');live.socket.send(frame(0,1,100));assert.match((await error).error,/今日.*音频/);
});

test('composite transcript pagination preserves every row sharing an equal timestamp',async t=>{
  const s=await setup(t);const a=await s.login(),interview=await s.create(a,{autoAnswer:false});
  for(let i=0;i<2105;i++){s.interviews.recordSegment(interview.id,'remote',String(i),{text:'内容 '+i,startMs:100,endMs:200,final:true},false);if(i%100===0)await new Promise(setImmediate);}
  const latest=await(await s.api(`/interviews/${interview.id}`,a)).json();assert.equal(latest.segments.length,2000);assert.equal(latest.segmentsTruncated,true);assert.match(latest.nextCursor,/^100:\d+$/);
  const previous=await(await s.api(`/interviews/${interview.id}?cursor=${encodeURIComponent(latest.nextCursor)}`,a)).json();assert.equal(previous.segments.length,105);
  assert.equal(new Set([...latest.segments,...previous.segments].map(x=>x.id)).size,2105);
  assert.equal((await(await s.api(`/interviews/${interview.id}/export`,a)).json()).segments.length,2105);
});

test('server restart recovers leased model work and pauses recordings without losing original speech',async t=>{
  const calls=[];const s=await setup(t,{textRunner:async input=>{calls.push(input);return new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));}});
  const a=await s.login(),interview=await s.create(a,{autoAnswer:false});s.interviews.recordSegment(interview.id,'self','actual',{text:'历史实际发言',startMs:0,endMs:100,final:true},false);
  assert.equal((await s.api(`/interviews/${interview.id}/questions`,a,'POST',{text:'为什么如此设计？'})).status,201);await waitFor(()=>calls.length===1);
  const nextApp=await s.restart({beforeOpen(){const db=openDatabase(s.dataDir);db.prepare("UPDATE interviews SET status='recording'").run();db.prepare("UPDATE interview_answers SET status='running',lease_until=?").run(new Date(Date.now()+3600000).toISOString());db.close();}});
  await waitFor(()=>nextApp.db.prepare("SELECT id FROM interview_answers WHERE status='completed'").get());
  const detail=await(await s.api(`/interviews/${interview.id}`,a)).json();assert.equal(detail.interview.status,'paused');assert.equal(detail.segments[0].text,'历史实际发言');assert.ok(detail.gaps.some(g=>g.reason.includes('重启')));assert.equal(detail.answers[0].text,'recovered answer');
});

test('realtime interview events remain owner-only and deletion reaches connected owner devices',async t=>{
  const s=await setup(t);const a=await s.login(),b=await s.login('b@example.com');
  async function connect(auth){const ticket=await(await s.api('/ws-ticket',auth,'POST',{})).json();const events=[],socket=new WebSocket(s.url.replace('http:','ws:')+'/ws?ticket='+ticket.ticket);socket.on('message',raw=>events.push(JSON.parse(raw.toString())));await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});return {socket,events};}
  const owner=await connect(a),other=await connect(b);const interview=await s.create(a,{autoAnswer:false});
  await s.api(`/interviews/${interview.id}/questions`,a,'POST',{text:'介绍系统'});await waitFor(()=>owner.events.some(e=>e.type==='interview.answer'&&e.answer.status==='completed'));
  assert.equal(other.events.some(e=>e.type.startsWith('interview.')),false);
  assert.equal((await s.api(`/interviews/${interview.id}`,a,'DELETE')).status,200);await waitFor(()=>owner.events.some(e=>e.type==='interview.deleted'));
  owner.socket.close();other.socket.close();
});

test('half-started ASR tasks close on startup failure and disabled accounts lose live audio access',async t=>{
  let first,attempts=0;
  const s=await setup(t,{asrFactory:async()=>{if(++attempts===2)throw new Error('startup rejected');first={closed:false,async write(){},async finish(){},close(){this.closed=true;}};return first;}});
  const a=await s.login(),b=await s.login('b@example.com'),device=await s.pair(b),interview=await s.create(device,{autoAnswer:false});
  const ticket=await(await s.api(`/interviews/${interview.id}/audio-ticket`,device,'POST',{})).json();const socket=new WebSocket(s.url.replace('http:','ws:')+ticket.path);await new Promise(r=>socket.once('open',r));const error=next(socket,'audio.error');socket.send(JSON.stringify({type:'audio.start',sampleRate:16000,format:'pcm_s16le',tracks:['remote','self']}));assert.match((await error).error,/无法启动/);await waitFor(()=>first.closed);
  assert.equal((await s.api(`/admin/users/${b.user.id}`,a,'PATCH',{disabled:true})).status,200);assert.equal((await s.api(`/interviews/${interview.id}`,b)).status,401);assert.equal((await s.api(`/interviews/${interview.id}/audio-ticket`,device,'POST',{})).status,401);assert.equal(s.db.prepare('SELECT status FROM interviews WHERE id=?').get(interview.id).status,'paused');
});

test('paused audio expires while transcript remains and retained-byte quota is released',async t=>{
  const s=await setup(t);const a=await s.login(),device=await s.pair(a),interview=await s.create(device,{autoAnswer:false});const live=await s.audio(interview,device);const ack=next(live.socket,'audio.ack');live.socket.send(frame());await ack;
  s.asrTasks[0].onResult({segmentId:'saved',text:'实际内容保留',startMs:0,endMs:100,final:true});await s.api(`/interviews/${interview.id}/pause`,a,'POST',{});
  assert.equal(s.db.prepare('SELECT bytes FROM interview_audio_storage').get().bytes,3200);
  s.db.prepare('UPDATE interviews SET updated_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',interview.id);
  await s.interviews.cleanupAudio();assert.equal(s.db.prepare('SELECT bytes FROM interview_audio_storage').get().bytes,0);assert.equal(s.db.prepare('SELECT text FROM interview_segments').get().text,'实际内容保留');assert.equal((await s.api(`/interviews/${interview.id}/audio/remote`,a)).status,404);
});

test('model timeout yields actionable failure for both answer and question and warmup honors provider',async t=>{
  const prepared=[];const runner=async input=>new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}));runner.prepareSession=async input=>prepared.push(input);
  const s=await setup(t,{textRunner:runner,interviews:{timeoutMs:100}}),a=await s.login(),interview=await s.create(a,{provider:'bailian',autoAnswer:false});assert.equal(prepared[0].provider,'bailian');
  await s.api(`/interviews/${interview.id}/questions`,a,'POST',{text:'测试超时'});await waitFor(()=>s.db.prepare("SELECT * FROM interview_answers WHERE status='failed'").get());
  const detail=await(await s.api(`/interviews/${interview.id}`,a)).json();assert.equal(detail.questions[0].status,'failed');assert.match(detail.answers[0].error,/超时/);
});

test('unexpected PC disconnect drains the connected upstream tail and still records an honest gap',async t=>{
  const s=await setup(t),a=await s.login(),device=await s.pair(a),interview=await s.create(device,{autoAnswer:false}),live=await s.audio(interview,device);
  s.asrTasks[0].finish=async()=>{s.asrTasks[0].onResult({segmentId:'disconnect-tail',text:'断线前最后一句实际发言',startMs:0,endMs:100,final:true});s.asrTasks[0].finished=true;};
  const ack=next(live.socket,'audio.ack');live.socket.send(frame());await ack;live.socket.terminate();
  await waitFor(()=>s.db.prepare('SELECT id FROM interview_segments WHERE text=?').get('断线前最后一句实际发言'));
  assert.equal(s.asrTasks[0].finished,true);assert.ok(s.db.prepare("SELECT id FROM interview_gaps WHERE reason LIKE '%中断%'").get());
});

test('setting zero retention purges prior ended PCM at startup while keeping transcript',async t=>{
  const s=await setup(t),a=await s.login(),device=await s.pair(a),interview=await s.create(device,{autoAnswer:false}),live=await s.audio(interview,device);
  const ack=next(live.socket,'audio.ack');live.socket.send(frame());await ack;s.asrTasks[0].onResult({segmentId:'private',text:'仍保留文字',startMs:0,endMs:100,final:true});await s.api(`/interviews/${interview.id}/end`,a,'POST',{});
  const reopened=await s.restart({interviews:{rawAudioRetentionDays:0}});assert.equal(reopened.db.prepare('SELECT bytes FROM interview_audio_storage').get().bytes,0);assert.equal(reopened.db.prepare('SELECT text FROM interview_segments').get().text,'仍保留文字');assert.equal((await s.api(`/interviews/${interview.id}/audio/remote`,a)).status,404);
});


test('administrator dual-mode defaults are inherited and manual is the default',async t=>{
 const s=await setup(t);const a=await s.login(),b=await s.login('b@example.com');
 const changed=await s.api('/interviews/preferences',a,'PATCH',{mode:'audio',provider:'claude',transcribe:false,audioModel:'qwen3.8-omni-flash-realtime',audioWindowSeconds:45});assert.equal(changed.status,200);
 assert.equal((await(await s.api('/interviews/preferences',a)).json()).preferences.mode,'audio');assert.equal((await(await s.api('/interviews/preferences',b)).json()).preferences.mode,'audio');
 const session=await s.create(a);assert.equal(session.mode,'audio');assert.equal(session.autoAnswer,false);assert.equal(session.audioWindowSeconds,45);
});

test('native audio without ASR records PCM and manually triggers an immutable answer with dedup and owner checks',async t=>{
 const calls=[];const s=await setup(t,{asrFactory:undefined,asr:{apiKey:'',workspaceId:''},audioRunner:async input=>{calls.push(input);return {answer:'native answer'};},interviews:{rawAudioRetentionDays:0}});
 const a=await s.login(),b=await s.login('b@example.com'),device=await s.pair(a),session=await s.create(device,{mode:'audio',transcribe:false});
 const live=await s.audio(session,device);const ack=next(live.socket,'audio.ack');const voiced=frame();for(let i=16;i<voiced.length;i+=2)voiced.writeInt16LE(1000,i);live.socket.send(voiced);await ack;
 assert.equal(s.db.prepare('SELECT asr_submitted FROM interview_audio_frames').get().asr_submitted,0);assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_answers').get().n,0);
 const requestId=randomBytes(16).toString('hex');const bad=await s.api(`/interviews/${session.id}/trigger`,b,'POST',{requestId});assert.equal(bad.status,404);
 const id='11111111-1111-4111-8111-111111111111';const r=await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:id});assert.equal(r.status,201);const body=await r.json();
 await waitFor(()=>calls.length);assert.equal(calls[0].audioTurns.at(-1).currentQuestion,true);assert.equal(calls[0].audioTurns.at(-1).pcm.length,3200);assert.equal(body.answer.provider,'omni');assert.equal(body.answer.mode,'audio');
 const repeated=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:id})).json();assert.equal(repeated.answer.id,body.answer.id);
 await waitFor(()=>s.db.prepare("SELECT status FROM interview_answers").get().status==='completed');assert.doesNotMatch(calls[0].prompt,/AI_ONLY_PRIVATE_SUGGESTION/);
 await s.api(`/interviews/${session.id}/end`,a,'POST',{});await s.interviews.cleanupAudio();assert.equal(s.db.prepare('SELECT byte_offset FROM interview_audio_frames').get().byte_offset,null);
});

test('manual transcript trigger accepts actual remote history and is not cancelled by late final revision',async t=>{
 const s=await setup(t);const a=await s.login(),device=await s.pair(a),session=await s.create(device);
 s.interviews.recordSegment(session.id,'self','s',{text:'本人使用SQLite',startMs:0,endMs:100,final:true},false);
 s.interviews.recordSegment(session.id,'remote','r',{text:'为什么选择SQLite？',startMs:200,endMs:300,final:true},false);
 const r=await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'22222222-2222-4222-8222-222222222222'});assert.equal(r.status,201);
 const body=await r.json();await waitFor(()=>s.prompts.length);assert.match(s.prompts[0],/本人使用SQLite/);
 s.interviews.recordSegment(session.id,'remote','r',{text:'为什么选择SQLite数据库？',startMs:200,endMs:300,final:true},false);
 await waitFor(()=>s.db.prepare('SELECT status FROM interview_answers WHERE id=?').get(body.answer.id).status==='completed');
 assert.equal(s.db.prepare('SELECT revision FROM interview_questions WHERE id=?').get(body.question.id).revision,1);
});


test('silence after a native question regenerates the same range and new voiced question cancels obsolete work',async t=>{
 const calls=[];const s=await setup(t,{audioRunner:async input=>{calls.push(input);if(calls.length===1)await new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));return {answer:'fresh native answer'};}});
 const a=await s.login(),device=await s.pair(a),session=await s.create(device,{mode:'audio',transcribe:false});const live=await s.audio(session,device);
 async function send(seq,time,amplitude){const f=frame(0,seq,time);for(let i=16;i<f.length;i+=2)f.writeInt16LE(amplitude,i);const ack=next(live.socket,'audio.ack');live.socket.send(f);await ack;}
 await send(0,0,1000);const first=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'33333333-3333-4333-8333-333333333333'})).json();await waitFor(()=>calls.length===1);
 await send(1,100,0);await new Promise(r=>setTimeout(r,620));const second=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'44444444-4444-4444-8444-444444444444'})).json();assert.equal(second.question.id,first.question.id);assert.notEqual(second.answer.id,first.answer.id);await waitFor(()=>calls.length===2);assert.equal(calls[0].signal.aborted,true);
 await send(2,200,2000);await new Promise(r=>setTimeout(r,620));const third=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'55555555-5555-4555-8555-555555555555'})).json();assert.notEqual(third.question.id,first.question.id);assert.equal(third.question.audioRange.endMs,300);
 assert.equal(calls[1].audioTurns.at(-1).endMs,100);
});

test('native background ASR failure is nonblocking and paused mode changes preserve explicit text questions',async t=>{
 const audioCalls=[],s=await setup(t,{asrFactory:async()=>{throw Error('upstream unavailable');},audioRunner:async i=>{audioCalls.push(i);return {answer:'audio'};}});
 const a=await s.login(),device=await s.pair(a),session=await s.create(device,{mode:'audio',transcribe:true,autoAnswer:true});assert.equal(session.autoAnswer,false);
 const live=await s.audio(session,device),f=frame();for(let i=16;i<f.length;i+=2)f.writeInt16LE(1000,i);const ack=next(live.socket,'audio.ack');live.socket.send(f);await ack;
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_audio_usage').get().n,0);
 const typed=await s.api(`/interviews/${session.id}/questions`,a,'POST',{text:'手动文字问题'});assert.equal(typed.status,201);const typedBody=await typed.json();assert.equal(typedBody.answer.mode,'transcript');await waitFor(()=>s.prompts.length===1);assert.equal(audioCalls.length,0);
 assert.equal((await s.api(`/interviews/${session.id}`,a,'PATCH',{mode:'transcript'})).status,409);await s.api(`/interviews/${session.id}/pause`,a,'POST',{});
 const changed=await s.api(`/interviews/${session.id}`,a,'PATCH',{mode:'transcript',audioWindowSeconds:30});assert.equal(changed.status,200);assert.equal((await changed.json()).interview.mode,'transcript');
});


test('native context preserves actual self speech inside current remote question padding',async t=>{
 const calls=[],s=await setup(t,{audioRunner:async i=>{calls.push(i);return {answer:'native'};}});const a=await s.login(),device=await s.pair(a),session=await s.create(device,{mode:'audio',transcribe:false}),live=await s.audio(session,device);
 for(const [track,start,amplitude] of [[1,100,1234],[0,300,2345]]){const f=frame(track,0,start);for(let i=16;i<f.length;i+=2)f.writeInt16LE(amplitude,i);const ack=next(live.socket,'audio.ack');live.socket.send(f);await ack;}
 await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'66666666-6666-4666-8666-666666666666'});await waitFor(()=>calls.length);
 const self=calls[0].audioTurns.find(t=>t.track==='self');assert.ok(self,'self audio must survive remote question padding');assert.equal(self.pcm.readInt16LE(100*32),1234);
});


test('optional native transcription write failure and ASR quota never interrupt durable native audio',async t=>{
 const s=await setup(t,{asrFactory:async options=>({...options,async write(){throw new Error('failed ASR write');},async finish(){},close(){}}),audioRunner:async()=>({answer:'audio'})});
 const a=await s.login(),device=await s.pair(a),session=await s.create(device,{mode:'audio',transcribe:true}),live=await s.audio(session,device);
 let ack=next(live.socket,'audio.ack');live.socket.send(frame());await ack;
 s.db.prepare('INSERT INTO interview_audio_usage(user_id,day,samples) VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET samples=excluded.samples').run(a.user.id,new Date().toISOString().slice(0,10),480*60*16000);
 ack=next(live.socket,'audio.ack');live.socket.send(frame(1,0,100));await ack;
 assert.equal(s.db.prepare('SELECT frame_count FROM interviews WHERE id=?').get(session.id).frame_count,2);assert.equal(live.socket.readyState,WebSocket.OPEN);
 assert.match(s.db.prepare('SELECT error FROM interviews WHERE id=?').get(session.id).error,/后台转写/);
});


test('manual transcript trigger waits for first new ASR after accepted voiced PCM instead of repeating old final',async t=>{
 const s=await setup(t),a=await s.login(),device=await s.pair(a),session=await s.create(device),live=await s.audio(session,device);
 async function voiced(seq,start){const f=frame(0,seq,start);for(let i=16;i<f.length;i+=2)f.writeInt16LE(1000,i);const ack=next(live.socket,'audio.ack');live.socket.send(f);await ack;}
 await voiced(0,0);s.interviews.recordSegment(session.id,'remote','old',{text:'旧的问题？',startMs:0,endMs:100,final:true},false);
 const first=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'77777777-7777-4777-8777-777777777777'})).json();await new Promise(r=>setTimeout(r,620));await voiced(1,200);
 setTimeout(()=>s.interviews.recordSegment(session.id,'remote','new',{text:'新的问题是什么？',startMs:200,endMs:300,final:true},false),200);
 const nextQuestion=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'88888888-8888-4888-8888-888888888888'})).json();assert.notEqual(nextQuestion.question.id,first.question.id);assert.match(nextQuestion.question.text,/新的问题/);
});


test('switching from native to transcript bypasses old trigger coalescing while retaining idempotent history',async t=>{
 const s=await setup(t,{audioRunner:async()=>({answer:'native'})}),a=await s.login(),device=await s.pair(a),session=await s.create(device,{mode:'audio',transcribe:false}),live=await s.audio(session,device);
 const f=frame();for(let i=16;i<f.length;i+=2)f.writeInt16LE(1000,i);const ack=next(live.socket,'audio.ack');live.socket.send(f);await ack;
 const id='99999999-9999-4999-8999-999999999999',first=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:id})).json();
 await s.api(`/interviews/${session.id}/pause`,a,'POST',{});await s.api(`/interviews/${session.id}`,a,'PATCH',{mode:'transcript'});await s.api(`/interviews/${session.id}/resume`,a,'POST',{});
 s.interviews.recordSegment(session.id,'remote','newmode',{text:'请解释数据库',startMs:300,endMs:400,final:true},false);
 const second=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})).json();assert.equal(second.answer.mode,'transcript');assert.notEqual(second.answer.id,first.answer.id);
 const old=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:id})).json();assert.equal(old.answer.id,first.answer.id);
});


test('explicit regeneration after partial becomes final reuses current question with final text',async t=>{
 const s=await setup(t,{interviews:{triggerTranscriptWaitMs:30}}),a=await s.login(),device=await s.pair(a),session=await s.create(device),live=await s.audio(session,device);
 const f=frame();for(let i=16;i<f.length;i+=2)f.writeInt16LE(1000,i);const ack=next(live.socket,'audio.ack');live.socket.send(f);await ack;
 s.interviews.recordSegment(session.id,'remote','partial',{text:'介绍一下',startMs:0,endMs:null,final:false},false);
 const first=await(await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})).json();
 s.interviews.recordSegment(session.id,'remote','partial',{text:'介绍一下你的项目',startMs:0,endMs:100,final:true},false);await new Promise(r=>setTimeout(r,620));
 const response=await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});assert.equal(response.status,201);const second=await response.json();assert.equal(second.question.id,first.question.id);assert.match(second.question.text,/你的项目/);assert.doesNotMatch(second.question.text,/尚未定稿/);
});


for(const actor of ['device','browser'])test(`pending manual trigger revalidates ${actor} credentials after transcript wait`,async t=>{
 const calls=[],s=await setup(t,{textRunner:async i=>{calls.push(i);return {answer:'must not run'};},interviews:{triggerTranscriptWaitMs:350}});
 const a=await s.login(),device=await s.pair(a),session=await s.create(device);
 s.interviews.recordSegment(session.id,'remote','waiting',{text:'请解释一下',startMs:0,endMs:null,final:false},false);
 const pending=s.api(`/interviews/${session.id}/trigger`,actor==='device'?device:a,'POST',{requestId:actor==='device'?'dddddddd-dddd-4ddd-8ddd-dddddddddddd':'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'});
 await new Promise(r=>setTimeout(r,80));
 const revoked=actor==='device'?await s.api(`/devices/${device.device.id}`,a,'DELETE'):await s.api('/auth/logout',a,'POST',{});assert.equal(revoked.status,200);
 const response=await pending;assert.ok([401,403].includes(response.status),`revoked trigger returned ${response.status}`);assert.equal(calls.length,0);assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_questions').get().n,0);
});


test('manual trigger pending queue is bounded per session',async t=>{
 const s=await setup(t,{interviews:{triggerTranscriptWaitMs:350}}),a=await s.login(),session=await s.create(a);
 s.interviews.recordSegment(session.id,'remote','wait',{text:'慢速识别提问',startMs:0,endMs:null,final:false},false);
 const pending=Array.from({length:4},()=>s.api(`/interviews/${session.id}/trigger`,a,'POST',{requestId:randomUUID()}));
 await new Promise(r=>setTimeout(r,60));const overflow=await s.api(`/interviews/${session.id}/trigger`,a,'POST',{requestId:'ffffffff-ffff-4fff-8fff-ffffffffffff'});assert.equal(overflow.status,429);await Promise.all(pending);
});


test('pending transcript trigger rejects a mode switch instead of dispatching mismatched native input',async t=>{
 const calls=[],s=await setup(t,{audioRunner:async i=>{calls.push(i);return {answer:'wrong'};},interviews:{triggerTranscriptWaitMs:350}}),a=await s.login(),session=await s.create(a);
 s.interviews.recordSegment(session.id,'remote','wait',{text:'正在转写问题',startMs:0,endMs:null,final:false},false);
 const pending=s.api(`/interviews/${session.id}/trigger`,a,'POST',{requestId:randomUUID()});await new Promise(r=>setTimeout(r,60));await s.api(`/interviews/${session.id}/pause`,a,'POST',{});assert.equal((await s.api(`/interviews/${session.id}`,a,'PATCH',{mode:'audio',transcribe:false})).status,200);
 assert.equal((await pending).status,409);assert.equal(calls.length,0);assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_questions').get().n,0);
});

test('HTTP ASR recording remains client-compatible, flushes on trigger and drains both tracks at pause',async t=>{
  const {createServer}=await import('node:http');let requests=0;
  const upstream=createServer(async(req,res)=>{let body='';for await(const data of req)body+=data;const input=JSON.parse(body);assert.equal(input.model,'qwen-audio-3.0-asr-flash');assert(input.input.messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,'));requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({output:{text:requests===1?'请解释 Redis 缓存。':'本人经历。'}}));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(async()=>{upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
  const calls=[];const s=await setup(t,{asrFactory:undefined,asr:{transport:'token-plan',apiKey:'fixture-only',model:'qwen-audio-3.0-asr-flash',httpUrl:`http://127.0.0.1:${upstream.address().port}/asr`},textRunner:async input=>{calls.push(input);return {answer:'参考回答'};}});
  const a=await s.login(),device=await s.pair(a),session=await s.create(device,{autoAnswer:false});
  const config=await(await s.api('/interviews/config',a)).json();assert.equal(config.configured,true);assert.equal(config.asrTransport,'http');
  const {socket}=await s.audio(session,device);
  const voiced=(track,seq,start)=>{const b=frame(track,seq,start);for(let i=16;i<b.length;i+=2)b.writeInt16LE(1000,i);return b;};
  let ack=next(socket,'audio.ack');socket.send(voiced(0,0,0));await ack;assert.equal(requests,0);
  const trigger=await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:randomUUID()});assert.equal(trigger.status,201);const result=await trigger.json();assert.match(result.question.text,/Redis/);await waitFor(()=>calls.length);assert.match(calls[0].prompt,/Redis/);
  ack=next(socket,'audio.ack');socket.send(voiced(1,0,1000));await ack;
  const pause=await s.api(`/interviews/${session.id}/pause`,a,'POST',{});assert.equal(pause.status,200);
  const detail=await(await s.api(`/interviews/${session.id}`,a)).json();assert.equal(requests,2);assert(detail.segments.some(x=>x.track==='remote'&&x.text.includes('Redis')&&x.startMs===0));assert(detail.segments.some(x=>x.track==='self'&&x.text==='本人经历。'&&x.startMs===1000));assert.equal(detail.gaps.length,0);
});

test('microphone-only audio gives an actionable answer-trigger error and broadcasts it to the owner',async t=>{
  const s=await setup(t),a=await s.login(),device=await s.pair(a),session=await s.create(device,{autoAnswer:false});
  const {socket}=await s.audio(session,device);const b=frame(1,0,0);for(let i=16;i<b.length;i+=2)b.writeInt16LE(1000,i);const ack=next(socket,'audio.ack');socket.send(b);await ack;
  const result=await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:randomUUID()});assert.equal(result.status,409);assert.match((await result.json()).error,/只录到了本人麦克风/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM interview_answers WHERE session_id=?').get(session.id).n,0);socket.close();
});

test('tail drain failure preserves the real ASR error instead of replacing it with a generic banner',async t=>{
  const s=await setup(t,{asrFactory:async()=>({async write(){},async finish(){throw new Error('识别接口权限不足 fixture');},close(){}})}),a=await s.login(),device=await s.pair(a),session=await s.create(device,{autoAnswer:false});
  await s.audio(session,device);const response=await s.api(`/interviews/${session.id}/pause`,a,'POST',{});assert.equal(response.status,200);
  const detail=await(await s.api(`/interviews/${session.id}`,a)).json();assert(detail.gaps.some(g=>g.reason.includes('识别接口权限不足 fixture')));
});

test('one rejected HTTP audio chunk marks its track gap while both recording tracks and answering stay available',async t=>{
  const {createServer}=await import('node:http');let requests=0;
  const upstream=createServer(async(req,res)=>{for await(const _ of req){}requests++;res.setHeader('content-type','application/json');if(requests===1){res.writeHead(400);res.end('{}');}else res.end(JSON.stringify({text:'请解释缓存。'}));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(async()=>{upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
  const s=await setup(t,{asrFactory:undefined,asr:{transport:'token-plan',apiKey:'fixture',chunkSeconds:2,model:'qwen-audio-3.0-asr-flash',httpUrl:`http://127.0.0.1:${upstream.address().port}/asr`}}),a=await s.login(),device=await s.pair(a),session=await s.create(device,{autoAnswer:false}),{socket}=await s.audio(session,device);
  for(let seq=0;seq<20;seq++){const b=frame(1,seq,seq*100);for(let i=16;i<b.length;i+=2)b.writeInt16LE(1000,i);const ack=next(socket,'audio.ack');socket.send(b);await ack;}
  await waitFor(()=>s.db.prepare('SELECT id FROM interview_gaps WHERE session_id=?').get(session.id));assert.equal(socket.readyState,WebSocket.OPEN);assert.equal(s.db.prepare('SELECT status FROM interviews WHERE id=?').get(session.id).status,'recording');
  const b=frame(0,0,0);for(let i=16;i<b.length;i+=2)b.writeInt16LE(1000,i);const ack=next(socket,'audio.ack');socket.send(b);await ack;
  const result=await s.api(`/interviews/${session.id}/trigger`,device,'POST',{requestId:randomUUID()});assert.equal(result.status,201);assert.match((await result.json()).question.text,/缓存/);
  const gap=s.db.prepare('SELECT track,reason FROM interview_gaps WHERE session_id=?').get(session.id);assert.equal(gap.track,'self');assert.match(gap.reason,/后续录音继续/);await s.api(`/interviews/${session.id}/pause`,a,'POST',{});
});
