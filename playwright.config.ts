import { defineConfig } from '@playwright/test'

// E2E against a dedicated kernel server (source CLI) on port 3100 with a fresh
// in-memory DB. The admin is served from the embedded build; preview uses the
// built-in renderer (no external frontend required).
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm exec tsx packages/cli/src/bin.ts dev --config e2e/kernel.config.ts --port 3100',
    url: 'http://localhost:3100/api/health',
    timeout: 90_000,
    reuseExistingServer: false,
    env: { KERNEL_SECRET: 'e2e-secret', KERNEL_LOG_LEVEL: 'error', KERNEL_API_KEY: 'e2e-key' },
  },
})
