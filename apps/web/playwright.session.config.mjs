import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
  testDir: './test-ui',
  testMatch: '*.spec.mjs',
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4318', viewport: { width: 1440, height: 1000 }, launchOptions: existsSync(edge) ? { executablePath: edge } : {} },
  webServer: { command: 'npm run preview --workspace @dual-link/web -- --port 4318 --strictPort', cwd: fileURLToPath(new URL('../..', import.meta.url)), url: 'http://127.0.0.1:4318/', reuseExistingServer: false },
});
