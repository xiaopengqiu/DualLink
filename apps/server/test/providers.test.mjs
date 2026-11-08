import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
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

test('Claude passes only approved custom-provider variables and retains isolation arguments', async t => {
  const values = {
    ANTHROPIC_AUTH_TOKEN: 'test-auth-token-not-real',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor-haiku-test',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'vendor-sonnet-test',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'vendor-opus-test',
    CLAUDE_CODE_SUBAGENT_MODEL: 'must-not-pass',
    DUALLINK_ARBITRARY_TEST_ENV: 'must-not-pass'
  };
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { jobDir } = await setup(t, 'claude');
  const invocation = await module.buildInvocation({}, { jobDir, provider: 'claude', prompt: 'test' });
  assert.equal(invocation.env.ANTHROPIC_AUTH_TOKEN, values.ANTHROPIC_AUTH_TOKEN);
  assert.equal(invocation.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, values.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  assert.equal(invocation.env.ANTHROPIC_DEFAULT_SONNET_MODEL, values.ANTHROPIC_DEFAULT_SONNET_MODEL);
  assert.equal(invocation.env.ANTHROPIC_DEFAULT_OPUS_MODEL, values.ANTHROPIC_DEFAULT_OPUS_MODEL);
  assert.equal(invocation.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
  assert.equal(invocation.env.DUALLINK_ARBITRARY_TEST_ENV, undefined);
  assert.deepEqual(invocation.args, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--no-session-persistence', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--safe-mode'
  ]);
});

test('Claude errors redact ANTHROPIC_AUTH_TOKEN values', async t => {
  const authToken = 'test-third-party-auth-token-not-real';
  const { run, ...input } = await setup(t, 'unused', {
    claudePrefixArgs: ['-e', 'process.stderr.write(`Authentication failed: ${process.env.ANTHROPIC_AUTH_TOKEN}`); process.exit(1)', '--'],
    extraEnv: { ANTHROPIC_AUTH_TOKEN: authToken }
  });
  await assert.rejects(run({ ...input, provider: 'claude', prompt: 'test' }), error => {
    assert.equal(error.code, 'AI_PROCESS_FAILED');
    assert.doesNotMatch(error.message, new RegExp(authToken));
    assert.match(error.message, /\[redacted\]/);
    return true;
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

test('multi-screenshot invocation preserves image order for Codex flags and Claude image blocks', async t => {
  const { jobDir, imagePath } = await setup(t, 'codex');
  const second = path.join(jobDir, 'second.jpg'); await writeFile(second, 'second-image');
  const input = { jobDir, imagePaths: [second, imagePath], provider: 'codex', prompt: 'same question' };
  const codex = await module.buildInvocation({}, input);
  const flags = codex.args.flatMap((value, i) => value === '--image' ? [codex.args[i + 1]] : []);
  assert.deepEqual(flags, await Promise.all([second, imagePath].map(file=>realpath(file))));
  const docker = await module.buildInvocation({ mode: 'docker' }, input);
  assert.deepEqual(docker.args.flatMap((value, i) => value === '--image' ? [docker.args[i + 1]] : []), ['/job/second.jpg', '/job/screen.png']);
  const claude = await module.buildInvocation({}, { ...input, provider: 'claude' });
  const content = JSON.parse(claude.stdin).message.content;
  assert.deepEqual(content.filter(c => c.type === 'image').map(c => [c.source.media_type, Buffer.from(c.source.data, 'base64').toString()]), [['image/jpeg', 'second-image'], ['image/png', 'image-fixture']]);
});

test('every multi-screenshot path and combined byte size are validated before building invocation', async t => {
  const { jobDir, imagePath } = await setup(t, 'codex');
  const input = { jobDir, provider: 'claude', prompt: 'same question' };
  await assert.rejects(module.buildInvocation({}, { ...input, imagePaths: [imagePath, path.join(jobDir, '..', 'outside.png')] }), e => e.code === 'INVALID_IMAGE_PATH');
  await assert.rejects(module.buildInvocation({}, { ...input, imagePaths: [] }), e => e.code === 'INVALID_IMAGES');
  await assert.rejects(module.buildInvocation({}, { ...input, imagePaths: Array(21).fill(imagePath) }), e => e.code === 'INVALID_IMAGES');
});
