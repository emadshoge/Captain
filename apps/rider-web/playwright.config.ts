import { defineConfig, devices } from '@playwright/test';

// Run through `pnpm e2e` (e2e/run.ts starts the API, worker, simulated
// gateway and web app against a throwaway database first).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:3001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Addis Ababa; the API prefers the scooter's own location when fresh.
    geolocation: { latitude: 9.01, longitude: 38.76 },
    permissions: ['geolocation'],
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The cloud dev image ships a fixed Chromium; CI installs the matching one.
        ...(process.env.PW_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
});
