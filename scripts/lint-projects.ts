/**
 * Which TypeScript project lints which directory, for `eslint.config.ts` and
 * `scripts/lint-typescript.ts`.
 *
 * Each directory maps to exactly one project, so a rule sees the same types
 * `pnpm typecheck` does and the parser builds only the program it needs. Given
 * a list instead, typescript-eslint tries every project in order until one
 * claims the file, building each program on the way (web-ui, last, ran out of
 * memory). The API's lint project adds its tests, which typecheck leaves out:
 * an un-awaited `assert.rejects(...)` passes vacuously, and that is precisely
 * what the promise rules exist to catch.
 */
export const typescriptProjects: Readonly<Record<string, string>> = {
  "scripts/**/*.ts": "./tsconfig.scripts.json",
  "e2e/**/*.ts": "./tsconfig.e2e.json",
  "apps/api/**/*.ts": "./apps/api/tsconfig.lint.json",
  "apps/web-rr/**/*.{ts,tsx}": "./apps/web-rr/tsconfig.json",
  "packages/glob-match/**/*.ts": "./packages/glob-match/tsconfig.json",
  "packages/web-http/**/*.ts": "./packages/web-http/tsconfig.json",
  "packages/web-ui/**/*.{ts,tsx}": "./packages/web-ui/tsconfig.json",
};
