/**
 * Compatibility re-export.
 *
 * The policy moved to `@bot-thk/web-http` (Phase 2 of ADR 0012) so the Next.js
 * route handlers, the React Router prototype and their contract tests share one
 * implementation. Existing `@/lib/authoring-proxy-policy.ts` imports keep working
 * until the App Router code is replaced at cutover, at which point this file is
 * deleted rather than rewritten.
 */
export * from "@bot-thk/web-http/policy";
