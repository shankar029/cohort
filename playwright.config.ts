import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ATEAM_E2E_PORT ?? 4399);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Build the web bundle then run the server in production mode with the Fake
    // adapter so E2E is deterministic and offline.
    command:
      'npm run build && cross-env ATEAM_FAKE_SDK=1 ATEAM_PORT=' +
      PORT +
      ' ATEAM_DB=:memory: NODE_ENV=production tsx src/server/index.ts',
    port: PORT,
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
