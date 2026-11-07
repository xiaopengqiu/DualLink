import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const module = await import('../src/text-providers.mjs').catch(() => ({}));
const cliFixture = fileURLToPath(new URL('./fixtures/provider-text.mjs', import.meta.url));
const rpcFixture = fileURLToPath(new URL('./fixtures/provider-appserver.mjs', import.meta.url));
async function setup(t, transport = 'exec', extra = {}) {
  assert.equal(typeof module.createTextRunner, 'function', 'text-only model runner must exist');
  const root = await mkdtemp(path.join(tmpdir(), 'dual-link-text-'));
  const jobDir = path.join(root, 'job'); await mkdir(jobDir);
  const journal = path.join(root, 'starts.txt');
  const runner = module.createTextRunner({
    mode: 'native', codexTransport: transport, timeoutMs: 3000,
    codexBin: process.execPath, claudeBin: process.execPath,
    codexPrefixArgs: [transport === 'app-server' ? rpcFixture : cliFixture, 'codex'],
    claudePrefixArgs: [cliFixture, 'claude'],
    extraEnv: { FIXTURE_JOURNAL: journal }, ...extra
  });
  t.after(async () => { await runner.close?.(); await rm(root, { recursive: true, force: true }); });
  return { runner, jobDir, root, journal };
}
test('Codex text questions use stdin without a dummy image', async t => {
  const { runner, jobDir } = await setup(t);
  const prompt = '面试官追问：为什么选 Redis？\n本人之前实际说过：项目使用本地缓存。';
  const result = await runner({ provider: 'codex', prompt, jobDir, sessionId: 'interview-1', userId: 'user-a' });
  assert.equal(result.answer, prompt);
});
test('Claude text requests contain only a text content block', async t => {
  const { runner, jobDir } = await setup(t);
  const deltas = [];
  const result = await runner({ provider: 'claude', prompt: '请回答技术问题', jobDir, onDelta: d => deltas.push(d) });
  assert.equal(result.answer, '请回答技术问题'); assert.deepEqual(deltas, ['请回答技术问题']);
});
test('warm Codex transport reuses a process within one interview, streams text and isolates another user', async t => {
  const { runner, jobDir, journal } = await setup(t, 'app-server');
  const deltas = [];
  const first = await runner({ provider: 'codex', prompt: 'first', jobDir, sessionId: 'same', userId: 'a', onDelta: d => deltas.push(d) });
  const second = await runner({ provider: 'codex', prompt: 'second', jobDir, sessionId: 'same', userId: 'a' });
  assert.equal(first.answer, 'first'); assert.equal(second.answer, 'second'); assert.deepEqual(deltas, ['fi', 'rst']);
  assert.equal((await readFile(journal, 'utf8')).trim().split('\n').length, 1);
  await runner({ provider: 'codex', prompt: 'other', jobDir, sessionId: 'same', userId: 'b' });
  assert.equal((await readFile(journal, 'utf8')).trim().split('\n').length, 2);
});
test('warm Codex cancellation interrupts an active turn before accepting the next question', async t => {
  const { runner, jobDir } = await setup(t, 'app-server');
  const abort = new AbortController();
  const pending = runner({ provider: 'codex', prompt: 'HANG', jobDir, sessionId: 's', userId: 'a', signal: abort.signal });
  setTimeout(() => abort.abort(), 180);
  await assert.rejects(pending, e => e.code === 'AI_CANCELLED');
  assert.equal((await runner({ provider: 'codex', prompt: 'next', jobDir, sessionId: 's', userId: 'a' })).answer, 'next');
});
test('warm Codex timeout is bounded and does not leak a raw tool event', async t => {
  const { runner, jobDir } = await setup(t, 'app-server', { timeoutMs: 200 });
  await assert.rejects(runner({ provider: 'codex', prompt: 'HANG', jobDir, sessionId: 's', userId: 'a' }), e => e.code === 'AI_TIMEOUT');
});
test('closing an interview removes its warm process so a future recording starts fresh', async t => {
  const { runner, jobDir, journal } = await setup(t, 'app-server');
  await runner({ provider: 'codex', prompt: 'one', jobDir, sessionId: 'session', userId: 'a' });
  await runner.closeSession('session');
  await runner({ provider: 'codex', prompt: 'two', jobDir, sessionId: 'session', userId: 'a' });
  assert.equal((await readFile(journal, 'utf8')).trim().split('\n').length, 2);
});
test('preparing an interview initializes the warm process before the first question', async t => {
  const { runner, jobDir, journal } = await setup(t, 'app-server');
  assert.equal(typeof runner.prepareSession,'function','warm interviews need a pre-start lifecycle');
  await runner.prepareSession({userId:'a',sessionId:'prepared',provider:'codex'});
  assert.equal((await readFile(journal,'utf8')).trim().split('\n').length,1);
  assert.equal((await runner({provider:'codex',prompt:'prepared answer',jobDir,userId:'a',sessionId:'prepared'})).answer,'prepared answer');
  assert.equal((await readFile(journal,'utf8')).trim().split('\n').length,1);
});
test('Bailian text API streams only answer deltas, keeps history in the request and disables thinking', async t => {
  const { runner: unused, jobDir } = await setup(t); await unused.close();
  let request;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    request={url:req.url,authorization:req.headers.authorization,body:JSON.parse(body)};
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'private'}}]})+'\n\n');
    for(const content of ['结论','：使用SQLite'])res.write('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n');
    res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:30,completion_tokens:10}})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>server.close(r)));
  const runner=module.createTextRunner({textApiKey:'test-api-key',textBaseUrl:`http://127.0.0.1:${server.address().port}/v1`,textModel:'qwen-flash'});t.after(()=>runner.close());
  const deltas=[];const prompt='本人之前说数据库是SQLite。当前面试官问数据库选型。';
  const result=await runner({provider:'bailian',jobDir,prompt,onDelta:d=>deltas.push(d)});
  assert.equal(result.answer,'结论：使用SQLite'); assert.deepEqual(deltas,['结论','：使用SQLite']);
  assert.equal(request.authorization,'Bearer test-api-key');assert.equal(request.url,'/v1/chat/completions');
  assert.equal(request.body.enable_thinking,false);assert.equal(request.body.messages[1].content,prompt);
  assert.equal(result.usage.completion_tokens,10);
});
test('Bailian rejects missing credentials without starting a request', async t => {
  const {runner:unused,jobDir}=await setup(t);await unused.close();
  const runner=module.createTextRunner({textApiKey:'',textBaseUrl:'https://example.invalid/v1'});t.after(()=>runner.close());
  await assert.rejects(runner({provider:'bailian',jobDir,prompt:'x'}),e=>e.code==='AI_NOT_CONFIGURED');
});
