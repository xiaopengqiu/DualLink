import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, rm, readFile, writeFile, truncate } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { hash, now } from '../src/auth.mjs';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/db.mjs';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');
async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dual-batch-'));
  const svc = await createApp({ dataDir, secureCookies: false, startWorker: false, ...options });
  await new Promise(resolve => svc.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${svc.server.address().port}/api`;
  t.after(async () => { await svc.close(); await rm(dataDir, { recursive: true, force: true }); });
  for (const email of ['owner@example.com', 'other@example.com']) svc.createUser({ email, name: email, password: 'correct-password-123', role: email.startsWith('owner') ? 'admin' : 'user' });
  async function login(email = 'owner@example.com') {
    const result = await fetch(url + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-password-123' }) });
    const body = await result.json();
    return { user: body.user, headers: { cookie: result.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': body.csrfToken } };
  }
  function api(route, auth, method = 'GET', body) {
    const multipart = body instanceof FormData;
    return fetch(url + route, { method, headers: { ...auth.headers, ...(!multipart && body ? { 'content-type': 'application/json' } : {}) }, body: body ? (multipart ? body : JSON.stringify(body)) : undefined });
  }
  async function capture(auth) {
    const form = new FormData(); form.set('captureId', randomUUID()); form.set('analyze', 'false'); form.set('image', new Blob([pixel], { type: 'image/png' }), 's.png');
    const result = await api('/captures', auth, 'POST', form); assert.equal(result.status, 201); return (await result.json()).capture;
  }
  return { ...svc, dataDir, api, login, capture };
}

test('one explicit trigger submits ordered related screenshots as one task and one AI answer', async t => {
  const calls = [];
  const s = await setup(t, { runner: async input => { calls.push({ ...input, bytes: await Promise.all(input.imagePaths.map(p => readFile(p))) }); return { answer: '整体答案' }; } });
  const auth = await s.login(); const one = await s.capture(auth), two = await s.capture(auth);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  const requestId = randomUUID(), captureIds = [two.id, one.id];
  const response = await s.api('/captures/analyze', auth, 'POST', { captureIds, requestId, provider: 'claude', model: 'qwen-max', question: '请整体作答' });
  assert.equal(response.status, 201);
  const { task } = await response.json();
  assert.deepEqual(task.captureIds, captureIds); assert.equal(task.captureId, two.id); assert.equal(task.requestId, requestId);
  assert.deepEqual(task.captures.map(c => c.id), captureIds);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM quota_events').get().n, 1);
  await s.worker.tick(); await s.worker.idle();
  assert.equal(calls.length, 1); assert.equal(calls[0].imagePaths.length, 2);
  assert.match(calls[0].prompt, /同一(?:道)?(?:题|问题)/); assert.match(calls[0].prompt, /顺序/); assert.match(calls[0].prompt, /重叠/);
  assert.equal(calls[0].model, 'qwen-max'); assert.equal(calls[0].provider, 'claude');
  const saved = (await (await s.api(`/tasks/${task.id}`, auth)).json()).task;
  assert.equal(saved.status, 'completed'); assert.equal(saved.answer, '整体答案'); assert.deepEqual(saved.captureIds, captureIds);
  const duplicate = await s.api('/captures/analyze', auth, 'POST', { captureIds, requestId, provider: 'claude', model: 'qwen-max', question: '请整体作答' });
  assert.equal(duplicate.status, 201); assert.equal((await duplicate.json()).task.id, task.id);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM quota_events').get().n, 1);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 1);
  const conflict = await s.api('/captures/analyze', auth, 'POST', { captureIds: [...captureIds].reverse(), requestId, provider: 'claude', model: 'qwen-max', question: '请整体作答' });
  assert.equal(conflict.status, 409);
  assert.equal((await s.api('/captures/analyze', auth, 'POST', { captureIds, requestId, provider: 'claude', model: 'other-model', question: '请整体作答' })).status, 409);
});

test('batch validation checks all screenshot ownership, duplicates, limits and request ids before allocating quota', async t => {
  const s = await setup(t), auth = await s.login(), other = await s.login('other@example.com');
  const one = await s.capture(auth), foreign = await s.capture(other);
  const valid = { captureIds: [one.id], requestId: randomUUID() };
  for (const input of [{ ...valid, captureIds: [] }, { ...valid, captureIds: [one.id, one.id] }, { ...valid, captureIds: Array.from({ length: 21 }, () => randomUUID()) }, { ...valid, requestId: '--bad' }, { ...valid, captureIds: ['../file'] }]) {
    assert.equal((await s.api('/captures/analyze', auth, 'POST', input)).status, 400);
  }
  assert.equal((await s.api('/captures/analyze', auth, 'POST', { ...valid, captureIds: [one.id, foreign.id] })).status, 404);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM quota_events').get().n, 0);
  const item = s.db.prepare('SELECT path FROM captures WHERE id=?').get(one.id);
  await writeFile(path.join(s.dataDir, item.path), Buffer.alloc(12 * 1024 * 1024 + 1));
  assert.equal((await s.api('/captures/analyze', auth, 'POST', valid)).status, 400);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
});

test('deleting any member of a grouped question removes the entire task instead of silently dropping that image', async t => {
  const s = await setup(t), auth = await s.login(), one = await s.capture(auth), two = await s.capture(auth);
  const response = await s.api('/captures/analyze', auth, 'POST', { captureIds: [one.id, two.id], requestId: randomUUID() });
  assert.equal(response.status, 201); const { task } = await response.json();
  assert.equal((await s.api(`/captures/${two.id}`, auth, 'DELETE')).status, 200);
  assert.equal((await s.api(`/tasks/${task.id}`, auth)).status, 404);
  assert.equal((await s.api(`/captures/${one.id}/image`, auth)).status, 200);
});

test('knowledge extraction and final answering both receive every related screenshot in original order', async t => {
  const calls = [];
  const s = await setup(t, { runner: async input => { calls.push(input); return { answer: calls.length === 1 ? '合并后的问题检索词' : '整体答案' }; } });
  const auth = await s.login(), one = await s.capture(auth), two = await s.capture(auth);
  const file = new FormData(); file.set('file', new Blob(['知识库'.repeat(6000)]), '知识.txt');
  assert.equal((await s.api('/knowledge', auth, 'POST', file)).status, 201);
  const response = await s.api('/captures/analyze', auth, 'POST', { captureIds: [two.id, one.id], requestId: randomUUID() });
  assert.equal(response.status, 201); await s.worker.tick(); await s.worker.idle();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].imagePaths, calls[1].imagePaths); assert.equal(calls[1].imagePaths.length, 2);
  assert.match(calls[0].prompt, /同一(?:道)?(?:题|问题)/); assert.match(calls[1].prompt, /同一(?:道)?(?:题|问题)/);
});

test('batch membership and idempotency survive database reopening and preference changes', async t => {
  const s = await setup(t), auth = await s.login(), one = await s.capture(auth), two = await s.capture(auth);
  const input = { captureIds: [two.id, one.id], requestId: randomUUID() };
  const response = await s.api('/captures/analyze', auth, 'POST', input); assert.equal(response.status, 201);
  const { task } = await response.json();
  const reopened = openDatabase(s.dataDir);
  try {
    assert.deepEqual(reopened.prepare('SELECT capture_id FROM task_captures WHERE task_id=? ORDER BY position').all(task.id).map(c => c.capture_id), input.captureIds);
    assert.equal(reopened.prepare('SELECT request_id FROM tasks WHERE id=?').get(task.id).request_id, input.requestId);
  } finally { reopened.close(); }
  assert.equal((await s.api('/model-preferences', auth, 'PUT', { preferences: { screenshot: { provider: 'claude', models: { claude: 'changed-model' } } } })).status, 200);
  const retry = await s.api('/captures/analyze', auth, 'POST', input); assert.equal(retry.status, 201);
  const after = (await retry.json()).task;
  assert.equal(after.id, task.id); assert.equal(after.provider, task.provider); assert.equal(after.model, task.model);
});

test('combined screenshot budget is enforced before allocating a task or quota event', async t => {
  const s = await setup(t), auth = await s.login(), captures = [];
  for (let i = 0; i < 9; i++) {
    const capture = await s.capture(auth); captures.push(capture.id);
    const row = s.db.prepare('SELECT path FROM captures WHERE id=?').get(capture.id);
    await truncate(path.join(s.dataDir, row.path), 12 * 1024 * 1024);
  }
  const response = await s.api('/captures/analyze', auth, 'POST', { captureIds: captures, requestId: randomUUID() });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /96 MiB/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM quota_events').get().n, 0);
});

test('concurrent retries share one task and quota while different triggers remain separate questions', async t => {
  const s = await setup(t), auth = await s.login(), capture = await s.capture(auth);
  const input = { captureIds: [capture.id], requestId: randomUUID() };
  s.db.prepare('UPDATE users SET daily_limit=1 WHERE id=?').run(auth.user.id);
  const results = await Promise.all(Array.from({ length: 3 }, () => s.api('/captures/analyze', auth, 'POST', input)));
  assert.deepEqual(results.map(result => result.status), [201, 201, 201]);
  const tasks = await Promise.all(results.map(async response => (await response.json()).task));
  assert.equal(new Set(tasks.map(task => task.id)).size, 1);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM quota_events').get().n, 1);
  assert.equal((await s.api('/captures/analyze', auth, 'POST', { ...input, requestId: randomUUID() })).status, 429);
  s.db.prepare('UPDATE users SET daily_limit=100 WHERE id=?').run(auth.user.id);
  const another = await s.api('/captures/analyze', auth, 'POST', { ...input, requestId: randomUUID() }); assert.equal(another.status, 201);
  assert.notEqual((await another.json()).task.id, tasks[0].id);
});

test('missing screenshots return typed recovery errors while absent API paths remain ordinary 404s', async t => {
  const s = await setup(t), auth = await s.login(), capture = await s.capture(auth);
  const missing = await s.api('/captures/analyze', auth, 'POST', { captureIds: [randomUUID()], requestId: randomUUID() });
  assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'CAPTURE_NOT_FOUND');
  const other = await s.login('other@example.com');
  const foreign = await s.api('/captures/analyze', other, 'POST', { captureIds: [capture.id], requestId: randomUUID() });
  assert.equal(foreign.status, 404); assert.equal((await foreign.json()).code, 'CAPTURE_NOT_FOUND');
  const row = s.db.prepare('SELECT path FROM captures WHERE id=?').get(capture.id); await fs.unlink(path.join(s.dataDir, row.path));
  const lostFile = await s.api('/captures/analyze', auth, 'POST', { captureIds: [capture.id], requestId: randomUUID() });
  assert.equal(lostFile.status, 409); assert.equal((await lostFile.json()).code, 'CAPTURE_FILE_MISSING');
  const absent = await s.api('/no-such-api', auth, 'POST', {}); assert.equal(absent.status, 404); assert.equal((await absent.json()).code, undefined);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
});

test('reuploading an owned capture key restores a missing file at its original id without creating a task', async t => {
  const s = await setup(t), auth = await s.login(), capture = await s.capture(auth);
  const row = s.db.prepare('SELECT path FROM captures WHERE id=?').get(capture.id); const filename = path.join(s.dataDir, row.path); await fs.unlink(filename);
  const form = () => { const f = new FormData(); f.set('captureId', capture.captureId); f.set('analyze', 'false'); f.set('image', new Blob([pixel]), 'original.png'); return f; };
  const responses = await Promise.all([s.api('/captures', auth, 'POST', form()), s.api('/captures', auth, 'POST', form())]);
  for (const response of responses) { assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.capture.id, capture.id); assert.equal(body.task, null); }
  assert.deepEqual(await readFile(filename), pixel); assert.equal(s.db.prepare('SELECT count(*) AS n FROM captures').get().n, 1);
  const result = await s.api('/captures/analyze', auth, 'POST', { captureIds: [capture.id], requestId: randomUUID() }); assert.equal(result.status, 201);
});

function holdFilesystemCall(t, method) {
  const original = fs[method]; let release, announce; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { announce = resolve; }); let held = false;
  fs[method] = async (...args) => { if (!held && String(args[0]).includes('screenshots')) { held = true; announce(); await gate; } return original(...args); };
  syncBuiltinESMExports();
  t.after(() => { release(); fs[method] = original; syncBuiltinESMExports(); });
  return { release, started };
}

for (const invalidation of ['logout', 'device revoke', 'disabled user']) test(`batch creation revalidates ${invalidation} after asynchronous file checks`, async t => {
  const s = await setup(t), auth = await s.login(), capture = await s.capture(auth);
  let requestAuth = auth, deviceId;
  if (invalidation === 'device revoke') {
    deviceId = randomUUID(); const secret = randomBytes(32).toString('hex');
    s.db.prepare('INSERT INTO devices(id,user_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(deviceId, auth.user.id, 'test', hash(secret), now(), now());
    requestAuth = { headers: { authorization: `Bearer ${secret}` } };
  }
  const hold = holdFilesystemCall(t, 'stat');
  const pending = s.api('/captures/analyze', requestAuth, 'POST', { captureIds: [capture.id], requestId: randomUUID() });
  await hold.started;
  if (invalidation === 'logout') assert.equal((await s.api('/auth/logout', auth, 'POST', {})).status, 200);
  else if (deviceId) s.db.prepare('DELETE FROM devices WHERE id=?').run(deviceId);
  else s.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(auth.user.id);
  hold.release(); const result = await pending; assert.equal(result.status, 401);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0); assert.equal(s.db.prepare('SELECT count(*) AS n FROM quota_events').get().n, 0);
});

test('capture upload revalidates logout before committing a file and screenshot row', async t => {
  const s = await setup(t), auth = await s.login(), hold = holdFilesystemCall(t, 'writeFile');
  const form = new FormData(); form.set('captureId', randomUUID()); form.set('analyze', 'false'); form.set('image', new Blob([pixel]), 's.png');
  const pending = s.api('/captures', auth, 'POST', form); await hold.started;
  assert.equal((await s.api('/auth/logout', auth, 'POST', {})).status, 200); hold.release();
  assert.equal((await pending).status, 401); assert.equal(s.db.prepare('SELECT count(*) AS n FROM captures').get().n, 0);
});

test('repair validates original image format and never creates a second legacy answer task', async t => {
  const s = await setup(t), auth = await s.login(), capture = await s.capture(auth);
  const taskResult = await s.api(`/captures/${capture.id}/analyze`, auth, 'POST', {}); const originalTask = (await taskResult.json()).task;
  const row = s.db.prepare('SELECT path FROM captures WHERE id=?').get(capture.id), filename = path.join(s.dataDir, row.path); await fs.unlink(filename);
  const { default: sharp } = await import('sharp'); const jpeg = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const form = bytes => { const f = new FormData(); f.set('captureId', capture.captureId); f.set('analyze', 'true'); f.set('image', new Blob([bytes]), 'screenshot'); return f; };
  const mismatch = await s.api('/captures', auth, 'POST', form(jpeg)); assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).code, 'CAPTURE_FORMAT_MISMATCH');
  await assert.rejects(fs.access(filename));
  const repaired = await s.api('/captures', auth, 'POST', form(pixel)); assert.equal(repaired.status, 200); assert.equal((await repaired.json()).task.id, originalTask.id);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 1);
});

test('file repair revalidates logout and removes uncommitted temporary content', async t => {
  const s = await setup(t), auth = await s.login(), capture = await s.capture(auth);
  const row = s.db.prepare('SELECT path FROM captures WHERE id=?').get(capture.id), filename = path.join(s.dataDir, row.path); await fs.unlink(filename);
  const hold = holdFilesystemCall(t, 'writeFile'), form = new FormData(); form.set('captureId', capture.captureId); form.set('analyze', 'false'); form.set('image', new Blob([pixel]), 's.png');
  const pending = s.api('/captures', auth, 'POST', form); await hold.started;
  assert.equal((await s.api('/auth/logout', auth, 'POST', {})).status, 200); hold.release();
  assert.equal((await pending).status, 401); await assert.rejects(fs.access(filename));
  assert.deepEqual(await fs.readdir(path.dirname(filename)), []);
});
