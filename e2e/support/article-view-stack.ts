import { test as base } from "@playwright/test";
import { startFontStack, type FontStack } from "./font-stack.ts";

// Attribution journeys need two actors on ONE real NAT, but must not spend the
// unrelated directory/editor journeys' 30/IP/hour budget. Reuse the existing
// disposable production-stack fixture, with its real API and no quota override.
export const test = base.extend<{ readingStack: FontStack }>({
  readingStack: [async ({}, use) => {
    const stack = await startFontStack();
    try { await use(stack); }
    finally { await stack.close(); }
  }, { timeout: 60_000 }],
  baseURL: async ({ readingStack }, use) => { await use(readingStack.webBaseUrl); },
});
