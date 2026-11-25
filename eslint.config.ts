import hooks from "eslint-plugin-react-hooks";
import a11y from "eslint-plugin-jsx-a11y";
// typescript-eslint, resolved against the TypeScript 6 compiler API it needs;
// the repository itself compiles with TypeScript 7 (see that package's index.js).
import tseslint from "@no-wave/eslint-typescript";
import { typescriptProjects } from "./scripts/lint-projects.ts";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/build/**",
      "**/dist/**",
      "**/.react-router/**",
      "**/coverage/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": hooks,
      "jsx-a11y": a11y,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "jsx-a11y/alt-text": "error",
      // A promise nobody awaits, returns, catches or explicitly `void`s loses its
      // rejection: the failure becomes an unhandled rejection, or in a test, a
      // pass. `void` stays the explicit, reviewable "fire and forget".
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: true,
          // node:test registers the test synchronously; the promise it returns
          // is the runner's to track, and awaiting it at top level would
          // serialize every file.
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["test", "it", "describe", "suite"],
            },
          ],
        },
      ],
      // A promise where a boolean or a void callback is expected: `if (check())`
      // is always true, and an async listener's rejection is never observed.
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  // One project per directory: see scripts/lint-projects.ts.
  ...Object.entries(typescriptProjects).map(([glob, project]) => ({
    files: [glob],
    languageOptions: { parserOptions: { project } },
  })),
  {
    // The configuration file itself is not part of any project above.
    files: ["eslint.config.ts"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: false, program: null, projectService: false },
    },
  },
];
