import { test, expect } from '@playwright/test';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function prepareWorkspace(page) {
  let current = null;
  const uploadSeen = deferred(), releaseUpload = deferred();
  const users = {
    a: { id: 'account-a', email: 'a@example.test', name: '账户甲', role: 'admin', disabled: false, dailyLimit: 10 },
    b: { id: 'account-b', email: 'b@example.test', name: '账户乙', role: 'admin', disabled: false, dailyLimit: 20 },
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const respond = (json, status = 200) => route.fulfill({ status, json });
    if (path === '/api/auth/login') { current = request.postDataJSON().email.startsWith('a@') ? 'a' : 'b'; return respond({ user: users[current], csrfToken: `csrf-${current}` }); }
    if (path === '/api/auth/logout') { current = null; return respond({ ok: true }); }
    if (path === '/api/auth/me') return current ? respond({ user: users[current], csrfToken: `csrf-${current}` }) : respond({ error: 'not logged in' }, 401);
    if (!current) return respond({ error: 'not logged in' }, 401);
    if (path === '/api/config') return respond({ providers: ['codex', 'claude'], defaultProvider: current === 'a' ? 'claude' : 'codex', autoAnalyze: current === 'b', iceServers: [], maxUploadBytes: 12 * 1024 * 1024 });
    if (path === '/api/ws-ticket') return respond({ ticket: `ticket-${current}` });
    if (path === '/api/captures' && request.method() === 'POST') {
      uploadSeen.resolve();
      await releaseUpload.promise;
      return respond({ capture: { id: 'old-capture', captureId: '8d083586-0631-4c5e-91a8-b84c994312cc', deviceId: 'pc-a', createdAt: new Date().toISOString(), imageUrl: '/old-private-image.png' }, task: null }).catch(() => {});
    }
    if (path === '/api/captures') return respond({ captures: [] });
    if (path === '/api/tasks') return respond({ tasks: [] });
    if (path === '/api/devices') return respond({ devices: [] });
    if (path === '/api/knowledge') return respond({ files: [] });
    if (path === '/api/prompts') return respond({ prompts: [{ id: `prompt-${current}`, name: `风格-${current}`, content: `${current}的私人风格`, isDefault: true, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] });
    if (path === '/api/admin/users') return respond({ users: [users[current]] });
    if (path === '/api/admin/diagnostics') return respond({ label: `${current}-private-diagnostics` });
    return respond({ ok: true });
  });
  await page.addInitScript(() => {
    window.__createdBlobs = []; window.__revokedBlobs = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.__createdBlobs.push(url); return url; };
    URL.revokeObjectURL = url => { window.__revokedBlobs.push(url); revoke(url); };
    class Socket {
      static OPEN = 1; static CONNECTING = 0;
      readyState = 0;
      constructor() { window.__socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; this.onclose?.(); }
    }
    class Connection {
      connectionState = 'new'; remoteDescription = null;
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        const channel = { label: 'dual-link-captures', readyState: 'open', close() { this.readyState = 'closed'; this.onclose?.(); }, send() {} };
        window.__channel = channel;
        this.ondatachannel?.({ channel });
      }
      async createAnswer() { return { type: 'answer', sdp: 'test-answer' }; }
      async setLocalDescription() {}
      async addIceCandidate() {}
      close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
    }
    window.WebSocket = Socket; window.RTCPeerConnection = Connection;
  });
  return { uploadSeen, releaseUpload };
}

async function login(page, account) {
  await page.getByLabel('邮箱地址').fill(`${account}@example.test`);
  await page.getByLabel('登录密码').fill('Test-Account-Password!');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.locator('.connection-pill')).toHaveText('已连接');
}

test('switching accounts clears RTC preview and private workspace drafts and revokes its blob URL', async ({ page }) => {
  const pending = await prepareWorkspace(page);
  await page.goto('/'); await login(page, 'a');
  await page.getByRole('button', { name: '用户管理', exact: true }).click();
  await page.getByRole('button', { name: '服务诊断' }).click();
  await expect(page.getByText('a-private-diagnostics', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '截图工作台', exact: true }).click();
  await page.getByLabel('补充说明').fill('A的私人问题');
  await page.getByLabel('搜索截图历史').fill('A的私人搜索');
  await page.evaluate(() => {
    window.__socket.onmessage({ data: JSON.stringify({ type: 'hello', devices: [], peers: [{ id: 'peer-a', kind: 'desktop', deviceId: 'pc-a' }] }) });
    window.__socket.onmessage({ data: JSON.stringify({ type: 'signal', fromPeerId: 'peer-a', deviceId: 'pc-a', payload: { kind: 'offer', sdp: 'test-offer' } }) });
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.__channel))).toBe(true);
  await page.evaluate(() => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZy0AAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const captureId = '8d083586-0631-4c5e-91a8-b84c994312cc';
    window.__channel.onmessage({ data: JSON.stringify({ type: 'capture.start', captureId, name: 'A-private.png', mime: 'image/png', size: png.byteLength, deviceId: 'pc-a', analyze: false, provider: 'claude' }) });
    window.__channel.onmessage({ data: png.buffer });
    window.__channel.onmessage({ data: JSON.stringify({ type: 'capture.end', captureId }) });
  });
  await pending.uploadSeen.promise;
  await expect(page.getByAltText('正在上传的局域网截图')).toBeVisible();
  const previewUrl = await page.getByAltText('正在上传的局域网截图').getAttribute('src');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(page, 'b');
  pending.releaseUpload.resolve();
  await expect(page.getByAltText('正在上传的局域网截图')).toHaveCount(0);
  await expect(page.getByLabel('补充说明')).toHaveValue('');
  await expect(page.getByLabel('搜索截图历史')).toHaveValue('');
  await expect(page.getByLabel('截图执行方式')).toHaveValue('codex');
  await expect(page.getByRole('combobox', { name: '回答风格', exact: true })).toHaveValue('prompt-b');
  await expect(page.getByText('截图不会自动回答。电脑按回答快捷键后，关联截图会统一生成一份答案；网页上传需点击下方回答。')).toBeVisible();
  await expect(page.getByRole('button', { name: '上传截图', exact: true })).toBeEnabled();
  expect(await page.evaluate(url => window.__revokedBlobs.includes(url), previewUrl)).toBe(true);
  await page.getByRole('button', { name: '用户管理', exact: true }).click();
  await expect(page.getByText('a-private-diagnostics', { exact: false })).toHaveCount(0);
});

test('account state reset preserves the pairing code supplied by the QR link', async ({ page }) => {
  await prepareWorkspace(page);
  await page.goto('/?pair=ABCD1234'); await login(page, 'b');
  await expect(page.getByLabel('电脑配对码')).toHaveValue('ABCD1234');
});
