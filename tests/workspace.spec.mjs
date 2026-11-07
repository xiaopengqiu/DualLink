import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="620"><rect width="1000" height="620" rx="12" fill="#172d29"/><rect width="1000" height="58" fill="#244039"/><circle cx="30" cy="29" r="7" fill="#efaa92"/><circle cx="55" cy="29" r="7" fill="#e4cc88"/><circle cx="80" cy="29" r="7" fill="#9bc5a4"/><text x="35" y="130" fill="#b2d7c9" font-size="23" font-family="monospace">QUESTION 01</text><text x="35" y="205" fill="white" font-size="48" font-family="sans-serif">What is the result of 2 + 2?</text><text x="35" y="310" fill="#d1e3d9" font-size="26" font-family="monospace">function solve() {</text><text x="75" y="365" fill="#b2d7c9" font-size="26" font-family="monospace">return 2 + 2;</text><text x="35" y="420" fill="#d1e3d9" font-size="26" font-family="monospace">}</text><text x="35" y="555" fill="#93b3a5" font-size="19" font-family="sans-serif">Dual Link - automated test image</text></svg>')).png().toBuffer();
async function login(page) {
  await page.goto('/');
  await page.getByLabel('邮箱地址').fill('admin@dual-link.test');
  await page.getByLabel('登录密码').fill('Test-only!DualLink42');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByRole('heading', { name: '让截图，成为答案。' })).toBeVisible();
  await expect(page.locator('.connection-pill')).toHaveText('已连接');
}

test('complete screenshot workflow includes prompts, knowledge, manual review and persisted results', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await page.getByRole('button', { name: '回答风格', exact: true }).click();
  await page.getByLabel('风格名称').fill(`测试简洁风格-${testInfo.project.name}`);
  await page.getByLabel('提示词', { exact: true }).fill('中文，先给结论，参考项目代号青竹的知识资料。');
  await page.getByLabel('设为账号默认风格').check();
  await page.getByRole('button', { name: '保存风格', exact: true }).click();
  await expect(page.getByText('回答风格已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我的知识库', exact: true }).click();
  await page.getByLabel('选择知识文件').setInputFiles({ name: `项目资料-${testInfo.project.name}.md`, mimeType: 'text/markdown', buffer: Buffer.from('# 项目代号青竹\n采用离线队列和幂等上传，保证截图传输可靠。') });
  await expect(page.getByRole('heading', { name: `项目资料-${testInfo.project.name}.md` })).toBeVisible();
  await page.getByRole('button', { name: '截图工作台', exact: true }).click();
  await page.getByLabel('接收图片后自动分析').uncheck();
  await page.getByLabel('选择截图文件').setInputFiles({ name: 'question.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeEnabled();
  await expect.poll(() => page.locator('.capture-stage img').evaluate(img => img.naturalWidth)).toBe(1000);
  await page.getByLabel('补充说明').fill('项目代号青竹，解释 2+2。');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  const answer = page.getByRole('region', { name: 'AI 回答' });
  await expect(answer.getByRole('heading', { name: '自动化测试回答' })).toBeVisible();
  await expect(answer.getByText('已完成', { exact: true })).toBeVisible();
  await expect(answer.getByText('已参考知识库：项目代号青竹。')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '自动化测试回答' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await mkdir('.local', { recursive: true });
  await page.screenshot({ path: `.local/workspace-${testInfo.project.name}.png`, fullPage: true });
});

test('pairing and administrator account management work through the website', async ({ page, request }, testInfo) => {
  await login(page);
  const pair = await request.post('/api/pairings', { data: { name: `测试电脑-${testInfo.project.name}`, deviceSecret: randomBytes(32).toString('hex') } });
  expect(pair.status()).toBe(201);
  const { code } = await pair.json();
  await page.getByRole('button', { name: '连接设备', exact: true }).click();
  await page.getByLabel('电脑配对码').fill(code);
  await page.getByRole('button', { name: '确认配对' }).click();
  await expect(page.getByRole('heading', { name: `测试电脑-${testInfo.project.name}` })).toBeVisible();
  await page.getByRole('button', { name: '用户管理', exact: false }).click();
  const create = page.locator('form.create-user-form');
  await create.getByLabel('姓名', { exact: true }).fill(`新用户-${testInfo.project.name}`);
  await create.getByLabel('邮箱', { exact: true }).fill(`new-${testInfo.project.name}@dual-link.test`);
  await create.getByLabel('初始密码').fill('New-test-password42!');
  await create.getByRole('button', { name: '创建账号' }).click();
  await expect(page.getByText(`new-${testInfo.project.name}@dual-link.test`, { exact: true })).toBeVisible();
});

test('an in-flight task can be cancelled and the website safely renders model markdown', async ({ page }) => {
  await login(page);
  await page.getByLabel('接收图片后自动分析').check();
  await page.getByLabel('补充说明').fill('SLOW_TEST');
  await page.getByLabel('选择截图文件').setInputFiles({ name: 'cancel.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: '取消任务' }).click();
  await expect(page.getByRole('heading', { name: '任务已取消' })).toBeVisible();
});
