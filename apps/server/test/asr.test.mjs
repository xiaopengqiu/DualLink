import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
const module = await import('../src/asr.mjs').catch(() => ({}));

async function upstream(t, behavior = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => server.once('listening', r));
  t.after(async () => { for (const c of server.clients) c.terminate(); await new Promise(r => server.close(r)); });
  const seen = { binary: [], actions: [] };
  server.on('connection', (ws, request) => {
    seen.authorization = request.headers.authorization;
    ws.on('message', (bytes, binary) => {
      if (binary) { seen.binary.push(Buffer.from(bytes)); behavior.audio?.(ws, seen.taskId); return; }
      const event = JSON.parse(bytes.toString()); seen.actions.push(event.header.action);
      if (event.header.action === 'run-task') {
        seen.run = event; seen.taskId = event.header.task_id;
        if (!behavior.noStart) setTimeout(() => ws.send(JSON.stringify({ header: { event: 'task-started', task_id: seen.taskId }, payload: {} })), behavior.delay || 0);
      } else if (event.header.action === 'finish-task') {
        behavior.finish?.(ws, seen.taskId);
        if (!behavior.noFinish) ws.send(JSON.stringify({ header: { event: 'task-finished', task_id: seen.taskId }, payload: { usage: { input_tokens: 20 } } }));
      }
    });
  });
  return { seen, url: `ws://127.0.0.1:${server.address().port}` };
}

test('real ASR wire waits for task-started, passes PCM/heatwords and drains final text at finish', async t => {
  assert.equal(typeof module.createDashScopeAsrFactory, 'function', 'ASR factory must exist');
  const results = [];
  const { seen, url } = await upstream(t, { delay: 30, audio(ws, taskId) {
    ws.send(JSON.stringify({ header: { event: 'result-generated', task_id: taskId }, payload: { output: { sentence: { sentence_id: 1, text: '介绍一下', begin_time: 0, end_time: null, sentence_end: false } } } }));
  }, finish(ws, taskId) {
    ws.send(JSON.stringify({ header: { event: 'result-generated', task_id: taskId }, payload: { output: { sentence: { sentence_id: 1, text: '介绍一下 Redis', begin_time: 0, end_time: 100, sentence_end: true } } } }));
  } });
  const factory = module.createDashScopeAsrFactory({ apiKey: 'server-only-secret', workspaceId: 'workspace', wsUrl: url });
  const task = await factory({ track: 'remote', sessionId: 'interview', hotwords: ['Redis'], onResult: r => results.push(r) });
  await task.write(Buffer.alloc(3200), 2500);
  await task.finish();
  assert.equal(seen.authorization, 'Bearer server-only-secret');
  assert.equal(seen.run.payload.parameters.sample_rate, 16000);
  assert.equal(seen.run.payload.parameters.format, 'pcm');
  assert.equal(seen.run.payload.parameters.heartbeat, true);
  assert.equal(seen.run.payload.parameters.vocabulary.Redis, 3);
  assert.equal(seen.binary.length, 1);
  assert.deepEqual(seen.actions, ['run-task', 'finish-task']);
  assert.equal(results.at(-1).text, '介绍一下 Redis');
  assert.equal(results.at(-1).startMs, 2500);
  assert.equal(results.at(-1).endMs, 2600);
  assert.equal(results.at(-1).final, true);
});

test('ASR startup and finish have bounded waits; missing credentials never create fake recognition', async t => {
  assert.equal(typeof module.createDashScopeAsrFactory, 'function', 'ASR factory must exist');
  const { url } = await upstream(t, { noStart: true });
  const factory = module.createDashScopeAsrFactory({ apiKey: 'key', wsUrl: url, startTimeoutMs: 40 });
  await assert.rejects(factory({ track: 'self', sessionId: 'x' }), e => e.code === 'ASR_START_TIMEOUT');
  await assert.rejects(module.createDashScopeAsrFactory({ apiKey: '', workspaceId: '' })({ track: 'remote', sessionId: 'x' }), e => e.code === 'ASR_NOT_CONFIGURED');
  const other = await upstream(t, { noFinish: true });
  const task = await module.createDashScopeAsrFactory({ apiKey: 'key', wsUrl: other.url, finishTimeoutMs: 40 })({ track: 'remote', sessionId: 'x' });
  await assert.rejects(task.finish(), e => e.code === 'ASR_FINISH_TIMEOUT');
});

test('per-session ASR model reaches wire without changing another session factory default',async t=>{
  const {seen,url}=await upstream(t);
  const factory=module.createDashScopeAsrFactory({apiKey:'secret',wsUrl:url,model:'qwen-audio-3.1-asr-flash-streaming'});
  const selected=await factory({track:'remote',model:'qwen-audio-3.0-asr-flash-streaming'});
  assert.equal(seen.run.payload.model,'qwen-audio-3.0-asr-flash-streaming');assert.equal(seen.run.payload.parameters.vad_model,undefined);await selected.finish();
  const other=await factory({track:'self'});assert.equal(seen.run.payload.model,'qwen-audio-3.1-asr-flash-streaming');assert.equal(seen.run.payload.parameters.vad_model,'near_meeting_16k');await other.finish();
});

test('ASR ignores heartbeat/foreign tasks and exposes safe errors rather than upstream secrets', async t => {
  assert.equal(typeof module.createDashScopeAsrFactory, 'function', 'ASR factory must exist');
  const results = [], errors = [];
  const { url } = await upstream(t, { audio(ws, taskId) {
    for (const [id, sentence] of [['foreign', { text: 'foreign', sentence_id: 1 }], [taskId, { text: 'heartbeat', heartbeat: true, sentence_id: 0 }]]) ws.send(JSON.stringify({ header: { event: 'result-generated', task_id: id }, payload: { output: { sentence } } }));
    ws.send(JSON.stringify({ header: { event: 'task-failed', task_id: taskId, error_code: 'InvalidApiKey', error_message: 'secret-123 private upstream message' } }));
  } });
  const task = await module.createDashScopeAsrFactory({ apiKey: 'secret-123', wsUrl: url })({ track: 'self', sessionId: 'x', onResult: r => results.push(r), onError: e => errors.push(e) });
  await task.write(Buffer.alloc(320), 0);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(results.length, 0);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0].message, /secret-123|private upstream/);
  await assert.rejects(task.write(Buffer.alloc(320), 20));
});

test('ASR validates frame bounds and maps discontinuous task audio onto session timestamps', async t => {
  assert.equal(typeof module.createDashScopeAsrFactory, 'function', 'ASR factory must exist');
  let writes = 0; const results = [];
  const { url } = await upstream(t, { audio(ws, taskId) { if (++writes === 2) ws.send(JSON.stringify({ header: { event: 'result-generated', task_id: taskId }, payload: { output: { sentence: { sentence_id: 2, text: 'second', begin_time: 100, end_time: 200, sentence_end: true } } } })); } });
  const task = await module.createDashScopeAsrFactory({ apiKey: 'key', wsUrl: url })({ track: 'remote', sessionId: 'x', onResult: r => results.push(r) });
  await assert.rejects(task.write(Buffer.alloc(6402), 0), /大小|frame/i);
  await task.write(Buffer.alloc(3200), 0);
  await task.write(Buffer.alloc(3200), 5000);
  await task.finish();
  assert.equal(results[0].startMs, 5000);
  assert.equal(results[0].endMs, 5100);
});
