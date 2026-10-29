import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level configuration.
 *
 * One project, one worker, one stack: the suite drives the same local
 * development stack a developer starts with `pnpm dev` (API on :4000, Web on
 * :3000, SQLite by default), and SQLite has a single writer. Parallel workers
 * would race each other over the same database and the same dev-server compile
 * cache, so throughput is bought with test isolation instead — every spec
 * creates its own account.
 *
 * The suite is deliberately small: it covers the complete journeys that unit,
 * API and SSR-parity checks structurally cannot see (Lexical editing, the save
 * and publish round trip, and the generated slug/summary). Everything else
 * belongs in the cheaper layers — see docs/testing/strategy.md.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "e2e",
  // A cold Next.js dev server compiles the editor on first hit; the budget has
  // to cover that, not just the navigation.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: process.env.CI ? true : false,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node scripts/dev.ts",
    url: baseURL,
    // A developer usually already has the stack running; CI never does.
    reuseExistingServer: process.env.CI ? false : true,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 240_000,
  },
});
