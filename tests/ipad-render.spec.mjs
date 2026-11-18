import { test, expect } from '@playwright/test';

test('iPad WebKit renders a recovery-capable login surface', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: '未登录' }) });
    if (url.pathname.endsWith('/auth/login')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'ipad-user', name: 'iPad 用户', email: 'ipad@example.test', role: 'user', dailyLimit: 20 }, csrfToken: 'ipad-csrf' }) });
    const payload = url.pathname.endsWith('/config') ? { providers: ['codex'], defaultProvider: 'codex' } : url.pathname.endsWith('/captures') ? { captures: [] } : url.pathname.endsWith('/tasks') ? { tasks: [] } : url.pathname.endsWith('/devices') ? { devices: [] } : url.pathname.endsWith('/prompts') ? { prompts: [] } : url.pathname.endsWith('/knowledge') ? { files: [] } : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/');
  await page.getByLabel('邮箱地址').fill('ipad@example.test');
  await page.getByLabel('登录密码').fill('test-password');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByRole('heading', { name: '让截图，成为答案。' })).toBeVisible();
  await expect(page.getByRole('button', { name: '截图工作台', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
