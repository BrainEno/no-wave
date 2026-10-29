import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level configuration.
 *
 * Two projects, one worker, one stack. Both projects run the same spec against
 * the same API and the same database — the App Router on :3000 and the React
 * Router prototype on :3100 — because the question the migration has to answer
 * is not "does this page render?" but "can an author sign up, write and publish
 * in both?". Running one spec twice is what makes that a fact rather than two
 * separate claims.
 *
 * One worker, because SQLite has a single writer and the two applications share
 * one database. Throughput is bought with test isolation instead: every test
 * creates its own account.
 *
 * The suite is deliberately small: it covers the complete journeys that unit,
 * API and SSR-parity checks structurally cannot see (Lexical editing, the save
 * and publish round trip, and the generated slug/summary). Everything else
 * belongs in the cheaper layers — see docs/testing/strategy.md.
 */
const apiUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";
const appRouterUrl = process.env.E2E_APP_ROUTER_URL ?? "http://127.0.0.1:3000";
const prototypeUrl = process.env.E2E_PROTOTYPE_URL ?? "http://127.0.0.1:3100";

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
  // `baseURL` is deliberately absent here: it is the one setting that differs
  // between the two projects, and putting it at the top level would let a spec
  // silently run against the wrong framework.
  use: {
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
    // The two frameworks, one spec. `baseURL` is the only difference, and the
    // spec reads it instead of hard-coding an origin, so a behaviour that holds
    // in one and not the other shows up as one failing project.
    { name: "app-router", use: { ...devices["Desktop Chrome"], baseURL: appRouterUrl } },
    { name: "prototype", use: { ...devices["Desktop Chrome"], baseURL: prototypeUrl } },
  ],
  // The suite runs against the production builds, not the dev servers: on a
  // cold CI runner `next dev` needs longer to compile the editor than a test
  // should wait, and the production servers are what readers actually use. The
  // API side is the same process `pnpm dev --api-only` starts. A developer who
  // already has `pnpm dev` running keeps it — nothing is started twice.
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
      command: "pnpm --filter @bot-thk/web start",
      url: appRouterUrl,
      reuseExistingServer: process.env.CI ? false : true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    },
    {
      // The prototype's own production server: plain Node.js, no platform
      // adapter (`apps/web-rr/server.ts`). It only needs somewhere to listen.
      command: "pnpm --filter @bot-thk/web-rr start",
      url: prototypeUrl,
      env: { PORT: String(new URL(prototypeUrl).port || 3100) },
      reuseExistingServer: process.env.CI ? false : true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    },
  ],
});
