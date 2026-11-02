import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level configuration.
 *
 * One project, one worker, one stack: the suite drives the Web application the
 * way a reader would — through the same production build, the same API and the
 * same database — because the question it answers is not "does this page
 * render?" but "can an author sign up, write and publish?".
 *
 * One worker, because SQLite has a single writer. Throughput is bought with
 * test isolation instead: every test creates its own account.
 *
 * The suite is deliberately small: it covers the complete journeys that unit,
 * API and HTTP-level checks structurally cannot see (Lexical editing, the save
 * and publish round trip, and the generated slug/summary). Everything else
 * belongs in the cheaper layers — see docs/testing/strategy.md.
 */
const apiUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";
const webUrl = process.env.E2E_WEB_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: process.env.CI ? true : false,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Form and account routes now keep native scrolling even with animation
    // enabled, so a click after scrolling cannot be swallowed by GSAP
    // ScrollSmoother. The suite still drives reduced motion for deterministic
    // behaviour; e2e/chrome-motion.spec.ts covers the normal-motion case.
    reducedMotion: "reduce",
    baseURL: webUrl,
  },
  projects: [{ name: "web", use: { ...devices["Desktop Chrome"] } }],
  // The suite runs against the production build, not the dev server: a cold CI
  // runner needs longer to compile than a test should wait, and the production
  // server is what readers actually use. The API side is the same process
  // `pnpm dev --api-only` starts. A developer who already has `pnpm dev`
  // running keeps it — nothing is started twice.
  webServer: [
    {
      command: "node scripts/dev.ts --api-only",
      url: apiUrl + "/ready",
      reuseExistingServer: process.env.CI ? false : true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    },
    {
      // The application's own production server: plain Node.js, no platform
      // adapter (`apps/web-rr/server.ts`). It only needs somewhere to listen.
      command: "pnpm --filter @bot-thk/web-rr start",
      url: webUrl,
      env: { PORT: String(new URL(webUrl).port || 3000) },
      reuseExistingServer: process.env.CI ? false : true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    },
  ],
});
