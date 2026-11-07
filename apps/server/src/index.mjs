import { createApp } from './app.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
if (process.env.NODE_ENV === 'production' && !/^https:\/\//.test(process.env.PUBLIC_ORIGIN || '')) throw new Error('Production requires PUBLIC_ORIGIN=https://your-domain');
const service = await createApp({
  cli: {
    mode: process.env.CLI_MODE || 'native',
    codexBin: process.env.CODEX_BIN || 'codex', claudeBin: process.env.CLAUDE_BIN || 'claude',
    codexModel: process.env.CODEX_MODEL || undefined, claudeModel: process.env.CLAUDE_MODEL || undefined,
    codexHome: process.env.CODEX_HOME || undefined, claudeHome: process.env.CLAUDE_CONFIG_DIR || undefined,
    runnerImage: process.env.AI_RUNNER_IMAGE || 'dual-link-ai:1.0.0',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 180000,
    codexLoadUserConfig: process.env.CODEX_LOAD_USER_CONFIG === 'true',
    claudeSafeMode: process.env.CLAUDE_SAFE_MODE !== 'false', claudeBare: (process.env.CLAUDE_BARE_MODE || process.env.CLAUDE_BARE) === 'true',
  },
});
service.server.listen(port, host, () => console.log(`Dual Link listening on http://${host}:${port}`));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await service.close(); process.exitCode = 0; }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
