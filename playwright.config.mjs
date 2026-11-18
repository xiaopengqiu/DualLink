import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.mjs',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4317',
    browserName: 'chromium',
    launchOptions: existsSync(edge) ? { executablePath: edge } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node tests/e2e-server.mjs',
    url: 'http://127.0.0.1:4317/api/health',
    reuseExistingServer: false,
    timeout: 30000
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'tablet', use: { viewport: { width: 820, height: 1180 }, hasTouch: true } },
    { name: 'tablet-landscape', use: { viewport: { width: 1180, height: 820 }, hasTouch: true } },
    { name: 'ipad-webkit', use: { browserName: 'webkit', viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, launchOptions: {}, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } }
  ]
});
