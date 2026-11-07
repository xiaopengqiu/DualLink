import { _electron as electron, chromium, expect } from '@playwright/test';
import { createApp } from '../apps/server/src/app.mjs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = await mkdtemp(path.join(tmpdir(), 'dual-link-desktop-e2e-'));
const clientDir = path.join(dataDir, 'client');
const service = await createApp({ dataDir: path.join(dataDir, 'server'), secureCookies: false, runner: async ({ onDelta }) => {
  const answer = '桌面端到端测试回答：2 + 2 = 4。'; onDelta?.(answer); return { answer };
} });
service.createUser({ email: 'desktop@test.example', name: '桌面联调账号', password: 'OnlyForTest42!', role: 'admin' });
await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${service.server.address().port}`;
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let browser, application;
try {
  browser = await chromium.launch(existsSync(edge) ? { executablePath: edge } : {});
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.goto(origin);
  await page.getByLabel('邮箱地址').fill('desktop@test.example');
  await page.getByLabel('登录密码').fill('OnlyForTest42!');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.locator('.connection-pill')).toHaveText('已连接');
  application = await electron.launch({
    ...(process.env.DUALLINK_PACKAGED_EXE ? { executablePath: process.env.DUALLINK_PACKAGED_EXE, args: [] } : { args: [path.join(root, 'apps/desktop')] }),
    env: { ...process.env, DUALLINK_TEST_MODE: '1', DUALLINK_TEST_USER_DATA: clientDir }
  });
  const desktop = await application.firstWindow();
  const desktopErrors = [];
  desktop.on('pageerror', error => desktopErrors.push(error.message));
  await desktop.getByLabel('云服务地址').fill(origin);
  await desktop.getByLabel('电脑名称').fill('集成测试 Windows');
  await desktop.getByRole('button', { name: '生成配对码', exact: false }).click();
  await expect(desktop.locator('#pair-code')).toHaveText(/^[A-Z2-9]{8}$/);
  const code = await desktop.locator('#pair-code').textContent();
  await page.getByRole('button', { name: '连接设备', exact: true }).click();
  await page.getByLabel('电脑配对码').fill(code);
  await page.getByRole('button', { name: '确认配对' }).click();
  await expect(desktop.locator('#connection-badge')).toHaveText('● 已连接', { timeout: 15000 });
  await expect.poll(() => desktop.evaluate(async () => (await window.dualLink.getState()).peerCount), { timeout: 20000 }).toBeGreaterThan(0);
  await desktop.getByRole('button', { name: '偏好设置' }).click();
  const primaryDisplayId = await application.evaluate(({ screen }) => String(screen.getPrimaryDisplay().id));
  await desktop.getByLabel('截图显示器').selectOption(primaryDisplayId);
  await desktop.locator('#lan-first').check();
  await desktop.locator('#analyze').uncheck();
  await desktop.getByRole('button', { name: '保存偏好设置' }).click();
  await expect(desktop.locator('#save-feedback')).toHaveText('✓ 设置已保存');
  await desktop.getByRole('button', { name: '连接与截图' }).click();
  // Cover the display with a synthetic question so no other desktop content is captured.
  await application.evaluate(async ({ BrowserWindow, screen }) => {
    const display = screen.getPrimaryDisplay();
    const cover = new BrowserWindow({ ...display.bounds, fullscreen: true, frame: false, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await cover.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#183a31;color:white;display:grid;place-items:center;height:100vh;font:80px sans-serif"><div>2 + 2 = ?<p style="font-size:24px">Dual Link integration test</p></div></body>'));
  });
  await page.getByRole('button', { name: '截图工作台', exact: true }).click();
  await desktop.getByRole('button', { name: '全屏截图', exact: false }).click();
  await expect.poll(() => service.db.prepare('SELECT count(*) AS n FROM captures').get().n).toBe(1);
  await expect.poll(() => desktop.evaluate(async () => (await window.dualLink.getState()).lastCapture?.status), { timeout: 15000 }).toBe('直传完成');
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0, 'PC manual review must not be bypassed');
  await expect(page.locator('.capture-stage img')).toBeVisible();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByText('桌面端到端测试回答：2 + 2 = 4。', { exact: true })).toBeVisible();
  await mkdir(path.join(root, '.local'), { recursive: true });
  await desktop.screenshot({ path: path.join(root, '.local/desktop-connected.png') });
  console.log('PASS: real Electron capture -> WebRTC -> browser upload -> persisted worker -> answer');

  await desktop.evaluate(() => { window.testPreviousPeer = [...peers.values()][0]; window.testPreviousPeer.channel.close(); });
  await expect.poll(() => desktop.evaluate(() => { const peer = [...peers.values()][0]; return !!peer && peer !== window.testPreviousPeer && peer.channel.readyState === 'open'; }), { timeout: 20000 }).toBe(true);
  const overlayPromise = application.waitForEvent('window');
  await desktop.getByRole('button', { name: '框选截图', exact: false }).click();
  const overlay = await overlayPromise;
  await expect.poll(() => overlay.locator('#screen').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await overlay.mouse.move(100, 100);
  await overlay.mouse.down();
  await overlay.mouse.move(340, 260, { steps: 5 });
  await overlay.mouse.up();
  await expect.poll(() => service.db.prepare('SELECT count(*) AS n FROM captures').get().n).toBe(2);
  const regionCapture = await desktop.evaluate(async () => (await window.dualLink.getState()).lastCapture);
  const scaleFactor = await application.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
  assert.equal(regionCapture.width, Math.round(240 * scaleFactor));
  assert.equal(regionCapture.height, Math.round(160 * scaleFactor));
  console.log('PASS: data-channel reconnect and real region capture with display scaling');

  // A connection/channel can close independently of the cloud account; force a cloud fallback.
  await desktop.getByRole('button', { name: '偏好设置' }).click();
  await desktop.locator('#lan-first').uncheck();
  await desktop.getByRole('button', { name: '保存偏好设置' }).click();
  await desktop.getByRole('button', { name: '连接与截图' }).click();
  await page.close();
  await desktop.getByRole('button', { name: '全屏截图', exact: false }).click();
  await expect.poll(() => service.db.prepare('SELECT count(*) AS n FROM captures').get().n).toBe(3);
  await expect.poll(() => desktop.evaluate(async () => (await window.dualLink.getState()).lastCapture?.status)).toBe('上传完成');
  console.log('PASS: cloud upload continues when the tablet page is closed');

  await desktop.locator('#preview-last').click();
  await expect(desktop.locator('#preview-dialog')).toBeVisible();

  // Cloud revocation must remove local sensitive state before a different account can pair.
  const device = service.db.prepare('SELECT id FROM devices').get();
  service.db.prepare('DELETE FROM devices WHERE id=?').run(device.id);
  await desktop.evaluate(() => window.dualLink.reconnect());
  await expect.poll(() => desktop.evaluate(async () => (await window.dualLink.getState()).paired)).toBe(false);
  assert.equal(await desktop.evaluate(async () => (await window.dualLink.lastImage()) === null), true, 'revoked pairing must clear the previous account screenshot preview');
  assert.deepEqual((await desktop.evaluate(() => window.dualLink.getState())).recent, []);
  await expect(desktop.locator('#preview-dialog')).not.toBeVisible();
  await expect(desktop.locator('#preview-image')).not.toHaveAttribute('src');
  assert.equal(desktopErrors.length, 0, desktopErrors.join('\n'));
  console.log('PASS: revocation clears credentials, queued files and local screenshot previews');
} finally {
  await application?.close();
  await browser?.close();
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
}
