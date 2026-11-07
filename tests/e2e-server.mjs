// This test-only server cannot be enabled through production environment flags.
import { createApp } from '../apps/server/src/app.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(tmpdir(), 'dual-link-e2e-'));
const service = await createApp({
  dataDir, secureCookies: false, publicOrigin: 'http://127.0.0.1:4317',
  runner: async ({ imagePath, prompt, signal, onDelta }) => {
    if (!(await readFile(imagePath)).length) throw new Error('Missing image');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, prompt.includes('SLOW_TEST') ? 20000 : 250);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled')); }, { once: true });
    });
    const answer = `## 自动化测试回答\n\n答案是 **4**。\n\n这是测试执行器验证的截图问答流程，不是真实模型输出。${prompt.includes('项目代号青竹') ? '\n\n已参考知识库：项目代号青竹。' : ''}\n\n\`\`\`js\nconsole.log(2 + 2);\n\`\`\``;
    onDelta?.(answer.slice(0, 15));
    onDelta?.(answer.slice(15));
    return { answer, usage: { input_tokens: 10, output_tokens: 20 } };
  }
});
service.createUser({ email: 'admin@dual-link.test', name: '测试管理员', password: 'Test-only!DualLink42', role: 'admin', dailyLimit: 10000 });
service.server.listen(4317, '127.0.0.1', () => console.log('Test fixture listening on 4317'));
let closing = false;
async function close() { if (closing) return; closing = true; await service.close(); await rm(dataDir, { recursive: true, force: true }); }
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
