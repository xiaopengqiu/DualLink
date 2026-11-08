import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const module = await import('../src/providers.mjs').catch(() => ({}));
const fixture = fileURLToPath(new URL('./fixtures/provider-fixture.mjs', import.meta.url));
async function setup(t, mode, options = {}) {
  assert.equal(typeof module.createCliRunner, 'function', 'CLI runner must be implemented');
  const dir = await mkdtemp(path.join(tmpdir(), 'dual-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, 'screen.png');
  await writeFile(imagePath, Buffer.from('image-fixture'));
  const run = module.createCliRunner({
    codexBin: process.execPath, claudeBin: process.execPath,
    codexPrefixArgs: [fixture, mode], claudePrefixArgs: [fixture, mode],
    timeoutMs: 3000, ...options
  });
  return { run, imagePath, jobDir: dir };
}

test('Codex uses stdin and a separate image argument, returns only the final assistant message', async t => {
  const { run, ...input } = await setup(t, 'codex');
  const prompt = '中文题目 ; $(touch should-not-run) `sensitive` --help';
  const result = await run({ ...input, provider: 'codex', prompt });
  assert.equal(result.answer, prompt);
  assert.deepEqual(result.usage, { input_tokens: 13, output_tokens: 7 });
});

test('Claude receives a real Base64 image block and emits text deltas without duplicating the final answer', async t => {
  const { run, ...input } = await setup(t, 'claude');
  const deltas = [];
  const result = await run({ ...input, provider: 'claude', prompt: '看图回答', onDelta: d => deltas.push(d) });
  assert.equal(result.answer, '你好世界');
  assert.deepEqual(deltas, ['你好', '世界']);
  assert.equal(result.usage.output_tokens, 4);
});

test('CLI timeout terminates the process and reports a structured timeout', async t => {
  const { run, ...input } = await setup(t, 'hang', { timeoutMs: 150 });
  await assert.rejects(run({ ...input, provider: 'codex', prompt: 'test' }), e => e.code === 'AI_TIMEOUT');
});

test('AbortSignal cancels an active CLI subprocess', async t => {
  const { run, ...input } = await setup(t, 'hang');
  const controller = new AbortController();
  const pending = run({ ...input, provider: 'codex', prompt: 'test', signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, e => e.code === 'AI_CANCELLED');
});

test('cancelling a CLI also terminates child processes it started', async t => {
  const { run, ...input } = await setup(t, 'tree', { timeoutMs: 400 });
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid); } catch {} } });
  await assert.rejects(run({ ...input, provider: 'codex', prompt: 'test' }), e => e.code === 'AI_TIMEOUT');
  pid = Number(await readFile(path.join(input.jobDir, 'child-process.pid'), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 100));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'CLI descendants must not survive task cancellation');
});

test('provider output is bounded and errors redact credentials', async t => {
  const { run, ...input } = await setup(t, 'overflow', { maxOutputBytes: 1000 });
  await assert.rejects(run({ ...input, provider: 'codex', prompt: 'test' }), e => e.code === 'AI_OUTPUT_LIMIT');
  const failure = await setup(t, 'failure', { extraEnv: { ANTHROPIC_API_KEY: 'secret-test-key' } });
  await assert.rejects(failure.run({ imagePath: failure.imagePath, jobDir: failure.jobDir, provider: 'claude', prompt: 'test' }), e => {
    assert.doesNotMatch(e.message, /secret-test-key/);
    return e.code === 'AI_PROCESS_FAILED';
  });
  const authToken = 'test-third-party-auth-token-not-real';
  const tokenFailure = await setup(t, 'unused', {
    claudePrefixArgs: ['-e', 'process.stderr.write(`Authentication failed: ${process.env.ANTHROPIC_AUTH_TOKEN}`); process.exit(1)', '--'],
    extraEnv: { ANTHROPIC_AUTH_TOKEN: authToken }
  });
  await assert.rejects(tokenFailure.run({ imagePath: tokenFailure.imagePath, jobDir: tokenFailure.jobDir, provider: 'claude', prompt: 'test' }), e => {
    assert.doesNotMatch(e.message, new RegExp(authToken));
    assert.match(e.message, /\[redacted\]/);
    return e.code === 'AI_PROCESS_FAILED';
  });
});

test('unknown providers and image paths outside a job are rejected before spawn', async t => {
  const { run, ...input } = await setup(t, 'codex');
  await assert.rejects(run({ ...input, provider: 'unknown', prompt: 'x' }), /provider|提供方/i);
  await assert.rejects(run({ ...input, imagePath: path.resolve(input.jobDir, '..', 'other.png'), provider: 'codex', prompt: 'x' }), /目录|outside/i);
});

test('Docker invocation mounts only the current job and explicitly configured credentials', async t => {
  const { jobDir, imagePath } = await setup(t, 'codex');
  assert.equal(typeof module.buildInvocation, 'function');
  const invocation = await module.buildInvocation({ mode: 'docker', runnerImage: 'dual-link-ai:1.0.0' }, { jobDir, imagePath, provider: 'codex', prompt: 'x' });
  assert.equal(invocation.command, 'docker');
  assert.ok(invocation.args.includes('--read-only'));
  assert.ok(invocation.args.includes('--cap-drop=ALL'));
  assert.ok(invocation.args.some(x => x.includes('target=/job')));
  assert.ok(!invocation.args.some(x => x.includes('docker.sock')));
  assert.ok(!invocation.args.some(x => x.includes('target=/data')));
});
