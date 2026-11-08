import { _electron as electron, chromium, expect } from '@playwright/test';
import { createApp } from '../apps/server/src/app.mjs';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = await mkdtemp(path.join(tmpdir(), 'dual-link-desktop-e2e-'));
const clientDir = path.join(dataDir, 'client');
const calls = [];
let releaseFirst;
const firstAnswerGate = new Promise(resolve => { releaseFirst = resolve; });
const service = await createApp({ dataDir: path.join(dataDir, 'server'), secureCookies: false, runner: async input => {
  calls.push({ imagePaths: input.imagePaths, prompt: input.prompt });
  if (calls.length === 1) await firstAnswerGate;
  const answer = `桌面端到端测试回答 ${calls.length}：2 + 2 = 4。`;
  input.onDelta?.(answer); return { answer };
} });
service.createUser({ email: 'desktop@test.example', name: '桌面联调账号', password: 'OnlyForTest42!', role: 'admin' });
await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${service.server.address().port}`;
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const desktopErrors = [];
let browser, application, desktop, dropNextAnswerResponse = false, deleteBeforeAnalyze = null, deletedCapture = null;
// Lose one successful HTTP response after the task is committed, reproducing an ambiguous retry.
service.server.prependListener('request', (request, response) => {
  if (request.method !== 'POST' || request.url !== '/api/captures/analyze') return;
  if (deleteBeforeAnalyze) {
    // Model a user/cleanup deleting a partially uploaded image before the explicit task is accepted.
    const capture = service.db.prepare('SELECT id,path FROM captures WHERE capture_key=?').get(deleteBeforeAnalyze);
    assert.ok(capture, 'recovery setup needs a successfully uploaded cloud image');
    const imagePath = path.resolve(service.dataDir, capture.path);
    assert.ok(imagePath.startsWith(path.resolve(service.dataDir) + path.sep));
    service.db.prepare('DELETE FROM captures WHERE id=?').run(capture.id);
    unlinkSync(imagePath);
    deletedCapture = { captureId: deleteBeforeAnalyze, oldId: capture.id };
    deleteBeforeAnalyze = null;
  }
  if (!dropNextAnswerResponse) return;
  dropNextAnswerResponse = false;
  const originalEnd = response.end;
  response.end = function (...args) {
    if (response.statusCode >= 200 && response.statusCode < 300) { response.destroy(); return response; }
    return originalEnd.apply(this, args);
  };
});
const count = table => service.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const state = () => desktop.evaluate(() => window.dualLink.getState());
async function launchClient() {
  application = await electron.launch({
    ...(process.env.DUALLINK_PACKAGED_EXE ? { executablePath: process.env.DUALLINK_PACKAGED_EXE, args: [] } : { args: [path.join(root, 'apps/desktop')] }),
    env: { ...process.env, DUALLINK_TEST_MODE: '1', DUALLINK_TEST_USER_DATA: clientDir }
  });
  desktop = await application.firstWindow();
  desktop.on('pageerror', error => desktopErrors.push(error.message));
}
async function coverDisplay() {
  // Keep all screenshots synthetic, including after restarting the client.
  await application.evaluate(async ({ BrowserWindow, screen }) => {
    const display = screen.getPrimaryDisplay();
    const cover = new BrowserWindow({ ...display.bounds, fullscreen: true, frame: false, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await cover.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#183a31;color:white;display:grid;place-items:center;height:100vh;font:80px sans-serif"><div>2 + 2 = ?<p style="font-size:24px">Dual Link integration test</p></div></body>'));
  });
}
async function captureFull() { await desktop.evaluate(() => window.dualLink.capture('full')); }
async function deferAutomaticRetry(batchId) {
  // Keep the offline retry schedule pending across restart so the visible retry button is exercised.
  const manifest = path.join(clientDir, 'pending', 'queue.json');
  const saved = JSON.parse(await readFile(manifest, 'utf8'));
  saved.batches.find(batch => batch.id === batchId).nextAttemptAt = Date.now() + 120000;
  await writeFile(manifest, JSON.stringify(saved));
}
try {
  browser = await chromium.launch(existsSync(edge) ? { executablePath: edge } : {});
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  let page = await context.newPage();
  await page.goto(origin);
  await page.getByLabel('邮箱地址').fill('desktop@test.example');
  await page.getByLabel('登录密码').fill('OnlyForTest42!');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.locator('.connection-pill')).toHaveText('已连接');
  await launchClient();
  await desktop.getByLabel('云服务地址').fill(origin);
  await desktop.getByLabel('电脑名称').fill('集成测试 Windows');
  await desktop.getByRole('button', { name: '生成配对码', exact: false }).click();
  await expect(desktop.locator('#pair-code')).toHaveText(/^[A-Z2-9]{8}$/);
  const code = await desktop.locator('#pair-code').textContent();
  await page.getByRole('button', { name: '连接设备', exact: true }).click();
  await page.getByLabel('电脑配对码').fill(code);
  await page.getByRole('button', { name: '确认配对' }).click();
  await expect(desktop.locator('#connection-badge')).toHaveText('● 已连接', { timeout: 15000 });
  await expect.poll(async () => (await state()).peerCount, { timeout: 20000 }).toBeGreaterThan(0);
  await desktop.getByRole('button', { name: '偏好设置' }).click();
  const primaryDisplayId = await application.evaluate(({ screen }) => String(screen.getPrimaryDisplay().id));
  await desktop.getByLabel('截图显示器').selectOption(primaryDisplayId);
  await desktop.locator('#lan-first').check();
  await desktop.getByRole('button', { name: '保存偏好设置' }).click();
  await expect(desktop.locator('#save-feedback')).toHaveText('✓ 设置已保存');
  await desktop.getByRole('button', { name: '连接与截图' }).click();
  await page.getByRole('button', { name: '截图工作台', exact: true }).click();
  await coverDisplay();
  await captureFull();
  assert.equal((await state()).screenshots?.pending.length, 1, 'capturing must stage one local screenshot');
  assert.equal(count('captures'), 0, 'a capture must not upload before an explicit answer trigger');
  assert.equal(count('tasks'), 0); assert.equal(calls.length, 0);
  assert.equal((await state()).queue.length, 0, 'staged screenshots are not an upload queue');
  await captureFull();
  const overlayPromise = application.waitForEvent('window');
  const regionCapturePromise = desktop.evaluate(() => window.dualLink.capture('region'));
  const overlay = await overlayPromise;
  await expect.poll(() => overlay.locator('#screen').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await overlay.mouse.move(100, 100); await overlay.mouse.down(); await overlay.mouse.move(340, 260, { steps: 5 }); await overlay.mouse.up();
  await regionCapturePromise;
  const regionCapture = (await state()).lastCapture;
  const scaleFactor = await application.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
  assert.equal(regionCapture.width, Math.round(240 * scaleFactor));
  assert.equal(regionCapture.height, Math.round(160 * scaleFactor));
  await captureFull();
  const accidentalId = (await state()).lastCapture.captureId;
  await desktop.evaluate(id => window.dualLink.discardScreenshot(id), accidentalId);
  const stagedIds = (await state()).screenshots.pending.map(item => item.captureId);
  assert.equal(stagedIds.length, 3); assert.ok(!stagedIds.includes(accidentalId));
  assert.equal(count('captures'), 0); assert.equal(count('tasks'), 0);
  assert.match(await desktop.evaluate(id => window.dualLink.screenshotPreview(id), stagedIds[0]), /^data:image\//);
  console.log('PASS: two full screenshots plus a region stay local, accidental screenshot can be removed');

  await application.close(); application = null;
  await launchClient();
  await expect(desktop.locator('#connection-badge')).toHaveText('● 已连接', { timeout: 15000 });
  assert.deepEqual((await state()).screenshots.pending.map(item => item.captureId), stagedIds);
  assert.equal(count('captures'), 0); assert.equal(count('tasks'), 0);
  await expect.poll(async () => (await state()).peerCount, { timeout: 20000 }).toBeGreaterThan(0);
  await coverDisplay();
  console.log('PASS: restart restores staged screenshots without submitting or losing them');

  // Invoke the exact dispatcher used by the registered answer shortcut twice in one tick.
  await desktop.evaluate(() => Promise.allSettled([window.dualLink.answerTrigger(), window.dualLink.answerTrigger()]));
  await expect.poll(() => count('captures'), { timeout: 20000 }).toBe(3);
  await expect.poll(() => count('tasks'), { timeout: 20000 }).toBe(1);
  await expect.poll(() => calls.length, { timeout: 15000 }).toBe(1);
  assert.equal(calls[0].imagePaths.length, 3, 'all screenshots must reach a single AI invocation');
  assert.match(calls[0].prompt, /同一|一个问题|一道题/);
  const firstTask = service.db.prepare('SELECT id FROM tasks').get();
  assert.deepEqual(service.db.prepare('SELECT c.capture_key FROM task_captures tc JOIN captures c ON c.id=tc.capture_id WHERE tc.task_id=? ORDER BY tc.position').all(firstTask.id).map(row => row.capture_key), stagedIds, 'the cloud task must preserve the capture order');
  await expect.poll(async () => (await state()).screenshots.pending.length).toBe(0);
  const firstBatch = (await state()).screenshots.batches.find(batch => batch.taskId === firstTask.id);
  assert.equal(firstBatch.count, 3);
  assert.equal((await state()).lastCapture.status, '直传完成');
  await expect(page.locator('.capture-stage img')).toBeVisible();
  console.log('PASS: explicit answer shortcut and duplicate keypress create one ordered three-image task over WebRTC');

  // A new screenshot while the previous answer is blocked belongs to the next question only.
  await captureFull();
  const nextId = (await state()).screenshots.pending[0].captureId;
  assert.ok(!stagedIds.includes(nextId)); assert.equal(count('captures'), 3); assert.equal(count('tasks'), 1);
  releaseFirst();
  await expect(page.getByText('桌面端到端测试回答 1：2 + 2 = 4。', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '本题关联截图' })).toBeVisible();
  await page.getByRole('button', { name: '查看本题第 1 张截图', exact: true }).click();
  await expect(page.getByText('桌面端到端测试回答 1：2 + 2 = 4。', { exact: true })).toBeVisible();
  assert.equal(calls.length, 1, 'viewing another screenshot in the group must not answer it separately');
  assert.equal((await state()).screenshots.pending.length, 1, 'finishing a prior answer must not consume next screenshots');
  await mkdir(path.join(root, '.local'), { recursive: true });
  await desktop.screenshot({ path: path.join(root, '.local/desktop-connected.png') });

  await desktop.evaluate(() => { window.testPreviousPeer = [...peers.values()][0]; window.testPreviousPeer.channel.close(); });
  await expect.poll(() => desktop.evaluate(() => { const peer = [...peers.values()][0]; return !!peer && peer !== window.testPreviousPeer && peer.channel.readyState === 'open'; }), { timeout: 20000 }).toBe(true);
  await desktop.getByRole('button', { name: '偏好设置' }).click();
  await desktop.locator('#lan-first').uncheck();
  await desktop.getByRole('button', { name: '保存偏好设置' }).click();
  await desktop.getByRole('button', { name: '连接与截图' }).click();
  await page.close();

  // Simulate a network break after task acceptance and retry after restarting the client.
  dropNextAnswerResponse = true;
  await desktop.evaluate(() => window.dualLink.submitScreenshots()).catch(() => {});
  await expect.poll(() => count('tasks'), { timeout: 15000 }).toBe(2);
  await expect.poll(async () => (await state()).screenshots.batches.find(batch => batch.status === 'failed')?.id, { timeout: 15000 }).toBeTruthy();
  const failedBatchId = (await state()).screenshots.batches.find(batch => batch.status === 'failed').id;
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM tasks WHERE request_id=?').get(failedBatchId).n, 1);
  assert.equal((await state()).queue.length, 0, 'all images uploaded before the task response was lost');
  await expect(desktop.locator('#retry')).toBeEnabled();
  await application.close(); application = null;
  await deferAutomaticRetry(failedBatchId);
  await launchClient();
  await expect(desktop.locator('#connection-badge')).toHaveText('● 已连接', { timeout: 15000 });
  await expect(desktop.locator('#retry')).toBeEnabled();
  await desktop.locator('#retry').click();
  await expect.poll(async () => (await state()).screenshots.batches.find(batch => batch.id === failedBatchId)?.status, { timeout: 20000 }).toBe('submitted');
  assert.equal(count('captures'), 4); assert.equal(count('tasks'), 2, 'lost task-creation response must not duplicate a question');
  await expect.poll(() => calls.length, { timeout: 15000 }).toBe(2);
  assert.equal(calls[1].imagePaths.length, 1, 'next question excludes screenshots from the previous batch');
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM quota_events').get().n, 2);
  console.log('PASS: next question stays isolated; cloud upload and idempotent task retry survive a lost response and restart');

  page = await context.newPage();
  await page.goto(origin);
  await expect(page.locator('.connection-pill')).toHaveText('已连接');
  await expect.poll(async () => (await state()).peerCount, { timeout: 20000 }).toBeGreaterThan(0);
  await desktop.evaluate(() => window.dualLink.saveSettings({ lanFirst: true }));
  await coverDisplay(); await captureFull(); await captureFull();
  const recoveryCaptureIds = (await state()).screenshots.pending.map(item => item.captureId);
  deleteBeforeAnalyze = recoveryCaptureIds[0];
  const recoveryResult = await desktop.evaluate(() => window.dualLink.submitScreenshots());
  const recoveryBatchId = recoveryResult.batchId;
  await expect.poll(async () => (await state()).screenshots.batches.find(batch => batch.id === recoveryBatchId)?.status, { timeout: 15000 }).toBe('failed');
  assert.equal(deletedCapture.captureId, recoveryCaptureIds[0]);
  assert.equal(count('tasks'), 2, 'an incomplete screenshot group must not create a partial answer');
  await application.close(); application = null;
  await deferAutomaticRetry(recoveryBatchId);
  await launchClient();
  await expect(desktop.locator('#connection-badge')).toHaveText('● 已连接', { timeout: 15000 });
  await expect.poll(async () => (await state()).peerCount, { timeout: 20000 }).toBeGreaterThan(0);
  await desktop.locator('#retry').click();
  await expect.poll(async () => (await state()).screenshots.batches.find(batch => batch.id === recoveryBatchId)?.status, { timeout: 20000 }).toBe('submitted');
  await expect.poll(() => calls.length, { timeout: 15000 }).toBe(3);
  assert.equal(calls[2].imagePaths.length, 2); assert.equal(count('captures'), 6); assert.equal(count('tasks'), 3);
  const restoredCapture = service.db.prepare('SELECT id FROM captures WHERE capture_key=?').get(recoveryCaptureIds[0]);
  assert.ok(restoredCapture); assert.notEqual(restoredCapture.id, deletedCapture.oldId);
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM tasks WHERE request_id=?').get(recoveryBatchId).n, 1);
  console.log('PASS: stale LAN ACK mapping is repaired through cloud upload after restart without splitting or duplicating the group');

  await coverDisplay(); await captureFull();
  assert.equal((await state()).screenshots.pending.length, 1);
  await desktop.locator('#preview-last').click();
  await expect(desktop.locator('#preview-dialog')).toBeVisible();
  // Revocation must remove pending and submitted local state before another account can pair.
  const device = service.db.prepare('SELECT id FROM devices').get();
  service.db.prepare('DELETE FROM devices WHERE id=?').run(device.id);
  await desktop.evaluate(() => window.dualLink.reconnect());
  await expect.poll(async () => (await state()).paired).toBe(false);
  assert.equal(await desktop.evaluate(async () => (await window.dualLink.lastImage()) === null), true);
  assert.deepEqual((await state()).recent, []); assert.deepEqual((await state()).screenshots.pending, []);
  assert.deepEqual((await state()).screenshots.batches, []);
  await expect(desktop.locator('#preview-dialog')).not.toBeVisible();
  await expect(desktop.locator('#preview-image')).not.toHaveAttribute('src');
  const persistedQueue = JSON.parse(await readFile(path.join(clientDir, 'pending', 'queue.json'), 'utf8'));
  assert.deepEqual(persistedQueue.items, []); assert.deepEqual(persistedQueue.batches, []);
  assert.equal(desktopErrors.length, 0, desktopErrors.join('\n'));
  console.log('PASS: revocation clears credentials, staged images, batch records and local previews');
} finally {
  releaseFirst();
  await application?.close();
  await browser?.close();
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
}
