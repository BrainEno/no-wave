import { test as base } from "@playwright/test";
import { startFontStack, type FontStack } from "./font-stack.ts";

// The same disposable production Web and real SQLite API serve both journeys.
// No quota increase, catalogue response mocking or production account is needed.
export const test = base.extend<{}, { tagStack: FontStack }>({
  tagStack: [async ({}, runWithStack) => {
    const stack = await startFontStack();
    try { await runWithStack(stack); }
    finally { await stack.close(); }
  }, { scope: "worker", timeout: 60_000 }],
});
