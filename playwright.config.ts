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
    // The site smooth-scrolls its content behind a transform (GSAP
    // ScrollSmoother, loaded only when the reader has not asked for reduced
    // motion). While that animation runs, content moves under the pointer:
    // mousedown and mouseup land on different elements, the browser dispatches
    // the resulting click on their common ancestor and the button's own handler
    // never runs — a click that silently does nothing. The suite asserts
    // behaviour, not animation, and the site already skips the smoother under
    // reduced motion, so that is how the browser is driven.
    reducedMotion: "reduce",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // The suite runs against the production Web build, not the dev server: on a
  // cold CI runner `next dev` needs longer to compile the editor than a test
  // should wait, and the production server is what readers actually use. The
  // API side is the same process `pnpm dev --api-only` starts. A developer who
  // already has `pnpm dev` running keeps it — nothing is started twice.
  webServer: [
    {
      command: "node scripts/dev.ts --api-only",
      url: (process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000") + "/ready",
      reuseExistingServer: process.env.CI ? false : true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    },
    {
      command: "pnpm --filter @bot-thk/web start",
      url: baseURL,
      reuseExistingServer: process.env.CI ? false : true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    },
  ],
});
