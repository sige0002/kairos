import { defineConfig, devices } from '@playwright/test';
import { stackEnv } from './fixtures/stack';

const env = stackEnv();

/**
 * Acceptance configuration for capture store v2 (contract §13).
 *
 * Three choices are load-bearing and none of them are style:
 *
 *   workers: 1 / fullyParallel: false — the suite drives ONE real stack with
 *     ONE recorder and ONE data directory. Two workers would have two browsers
 *     racing for the same recorder session, and the §13-4 scenario restarts the
 *     whole stack underneath whatever else is running. Serial is not a
 *     performance compromise here, it is the only correct execution model.
 *
 *   retries: 0 — a retry re-runs a scenario against a store the first attempt
 *     already mutated (a discarded capture stays discarded). A flake that is
 *     silently retried into green is exactly the failure mode an acceptance
 *     gate exists to prevent, so a failure stays a failure.
 *
 *   forbidOnly — a stray `.only` would turn the gate into a single scenario
 *     while still reporting a pass.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './fixtures/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // Generous but bounded. A recording is a real ROS session: arming waits on
  // DDS discovery (discovery_timeout_s: 10 in the HSR config), and the §13-4
  // scenario stops and restarts the stack inside a single test.
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: env.baseUrl,
    // Every failure has to be diagnosable without re-running: the stack is
    // expensive to reproduce and its state has already moved on.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } },
    },
  ],
});
