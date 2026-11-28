import { test as base } from "./csp-fixture.ts";
import { startFontStack, type FontStack } from "./font-stack.ts";

/**
 * The editor's contract with the reader, on a stack of its own.
 *
 * Why a stack per test: the browser suite's article-creation budget is thirty
 * per IP per hour, and every work this contract publishes spends one. A test
 * that shared the suite's database would take that budget away from the
 * journeys that run beside it — and the contract publishes one work per test,
 * five tests deep, so the budget would run out halfway through the file and
 * the failure would look like a broken editor rather than a spent allowance.
 *
 * So each test gets a disposable production stack: the real build, the real
 * API, a private SQLite database and ephemeral ports. No limit is changed, and
 * no test depends on another test's data.
 */
export const test = base.extend<{ editorStack: FontStack }>({
  editorStack: [
    async ({}, runWithStack) => {
      const stack = await startFontStack();
      try {
        await runWithStack(stack);
      } finally {
        await stack.close();
      }
    },
    { timeout: 60_000 },
  ],
  baseURL: async ({ editorStack }, runWithBaseUrl) => {
    await runWithBaseUrl(editorStack.webBaseUrl);
  },
});
