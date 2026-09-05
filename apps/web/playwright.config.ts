import { defineConfig, devices } from '@playwright/test';

import { AGENT_TOKEN, AGENT_URL } from './e2e/harness.mjs';

/**
 * The Phase 9 gate.
 *
 * Runs against a production build rather than the dev server. A dashboard whose
 * only tested configuration is `next dev` is a dashboard nobody has tested —
 * server components, caching, and the security headers all behave differently
 * once built, and those differences are exactly where a dashboard breaks.
 *
 * Serial, one worker. These tests share one agent server holding one project,
 * and parallel workers racing over the same run history would produce failures
 * that depend on scheduling.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? 'list' : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://127.0.0.1:3210',
    trace: 'retain-on-failure',
    // A local tool: no reason for a browser here to reach anything else.
    bypassCSP: false,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npx next start --port 3210',
    url: 'http://127.0.0.1:3210',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      // The dashboard reads these on its own server side; the browser never
      // sees either of them.
      AICA_SERVER_URL: AGENT_URL,
      AICA_SERVER_TOKEN: AGENT_TOKEN,
    },
  },
});
