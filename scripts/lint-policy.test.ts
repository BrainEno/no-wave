import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const eslint = fileURLToPath(
  new URL("../node_modules/eslint/bin/eslint.js", import.meta.url),
);
const stylelint = fileURLToPath(
  new URL("../node_modules/stylelint/bin/stylelint.mjs", import.meta.url),
);

type Message = { ruleId: string | null; message: string; severity: number };
type Result = { messages: Message[] };

let fixtures = 0;

/**
 * Lint `source` as a file at `filename`'s directory and extension, with the
 * same configuration and inline-suppression policy CI uses.
 *
 * Type-aware rules only parse files that belong to a TypeScript project, and a
 * project is the files on disk, so the fixture is written next to real sources
 * (under a unique, gitignored name) and always removed.
 */
function lint(
  source: string,
  filename = "packages/web-ui/src/lint-fixture.tsx",
): Result {
  const directory = dirname(filename);
  const fixture = join(
    directory,
    `lint-fixture-${process.pid}-${++fixtures}${extname(filename)}`,
  );
  writeFileSync(join(root, fixture), source);
  try {
    const run = spawnSync(
      process.execPath,
      [
        eslint,
        "--flag",
        "unstable_native_nodejs_ts_config",
        "--no-inline-config",
        "--format",
        "json",
        fixture,
      ],
      { cwd: root, encoding: "utf8", timeout: 90_000 },
    );
    assert.equal(
      run.error,
      undefined,
      run.error?.message ?? "lint process failed",
    );
    assert.ok(run.status === 0 || run.status === 1, run.stderr);
    const results = JSON.parse(run.stdout) as Result[];
    assert.equal(results.length, 1);
    return results[0]!;
  } finally {
    rmSync(join(root, fixture), { force: true });
  }
}

function errors(source: string, filename?: string): string[] {
  return lint(source, filename)
    .messages.filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? "parse error");
}

test("missing effect dependencies fail rather than silently capturing stale values", () => {
  const source = `import { useEffect } from "react";
    export function View({ id }: { id: string }) {
      useEffect(() => { console.log(id); }, []);
      return <p>{id}</p>;
    }`;
  assert.ok(errors(source).includes("react-hooks/exhaustive-deps"));
  assert.deepEqual(errors(source.replace("}, []);", "}, [id]);")), []);
});

test("callback and memo dependencies are checked, not just effects", () => {
  const source = `import { useCallback, useMemo } from "react";
    export function View({ value }: { value: string }) {
      const label = useMemo(() => value.toUpperCase(), []);
      const click = useCallback(() => console.log(value), []);
      return <button onClick={click}>{label}</button>;
    }`;
  const found = errors(source).filter(
    (rule) => rule === "react-hooks/exhaustive-deps",
  );
  assert.equal(found.length, 2);
});

test("conditional hooks and hooks in ordinary callbacks are rejected", () => {
  const conditional = `import { useState } from "react";
    export function View({ show }: { show: boolean }) {
      if (show) useState(0);
      return null;
    }`;
  const callback = `import { useState } from "react";
    export function View() {
      const onClick = () => { useState(0); };
      return <button onClick={onClick}>Go</button>;
    }`;
  assert.ok(errors(conditional).includes("react-hooks/rules-of-hooks"));
  assert.ok(errors(callback).includes("react-hooks/rules-of-hooks"));
});

test("ordinary functions are not hooks merely because they implement a fallback", () => {
  const source = `export function View() {
    const activateFallback = () => console.log("fallback");
    return <button onClick={activateFallback}>Go</button>;
  }`;
  assert.deepEqual(errors(source), []);
});

test("images require explicit alt text, including when other props are spread", () => {
  assert.ok(
    errors('const image = <img src="/a.png" />;').includes("jsx-a11y/alt-text"),
  );
  assert.ok(
    errors('const image = <img {...props} src="/a.png" />;').includes(
      "jsx-a11y/alt-text",
    ),
  );
  assert.deepEqual(errors('const image = <img src="/a.png" alt="" />;'), []);
  assert.deepEqual(
    errors('const image = <img src="/a.png" alt="A bird" />;'),
    [],
  );
});

test("inline disable comments cannot hide a missing dependency or image alt", () => {
  const source = `/* eslint-disable jsx-a11y/alt-text, react-hooks/exhaustive-deps */
    import { useEffect } from "react";
    export function View({ id }: { id: string }) {
      useEffect(() => console.log(id), []);
      return <img src="/a" />;
    }`;
  const found = errors(source);
  assert.ok(found.includes("jsx-a11y/alt-text"));
  assert.ok(found.includes("react-hooks/exhaustive-deps"));
});

test("rule enforcement applies to route and shared UI components", () => {
  const source = 'export const image = <img src="/a" />;';
  for (const path of [
    "apps/web-rr/app/fixture.tsx",
    "packages/web-ui/src/fixture.tsx",
  ]) {
    assert.ok(errors(source, path).includes("jsx-a11y/alt-text"), path);
  }
});

const FLOATING = `export async function save(): Promise<void> {}
export function submit() {
  save();
}`;

test("an un-awaited, un-voided promise fails in every linted project, including the API", () => {
  for (const path of [
    "apps/api/src/fixture.ts",
    "apps/web-rr/app/fixture.ts",
    "packages/web-http/src/fixture.ts",
    "packages/web-ui/src/lib/fixture.ts",
    "scripts/fixture.ts",
    "e2e/fixture.ts",
  ]) {
    assert.ok(
      errors(FLOATING, path).includes(
        "@typescript-eslint/no-floating-promises",
      ),
      path,
    );
  }
});

test("awaiting, returning, catching or an explicit void settles the promise", () => {
  for (const settled of [
    "await save();",
    "void save();",
    "save().catch(() => undefined);",
  ]) {
    const source = FLOATING.replace(
      "export function submit() {\n  save();",
      `export async function submit() {\n  ${settled}`,
    );
    assert.deepEqual(errors(source, "apps/api/src/fixture.ts"), [], settled);
  }
});

test("an inline disable comment cannot hide a floating promise", () => {
  const source = FLOATING.replace(
    "  save();",
    "  // eslint-disable-next-line @typescript-eslint/no-floating-promises\n  save();",
  );
  assert.ok(
    errors(source, "apps/api/src/fixture.ts").includes(
      "@typescript-eslint/no-floating-promises",
    ),
  );
});

test("API tests are typed too: an un-awaited assert.rejects is caught, node:test registration is not", () => {
  const source = `import assert from "node:assert/strict";
import test from "node:test";
test("refuses", async () => {
  assert.rejects(Promise.reject(new Error("no")));
});`;
  assert.deepEqual(errors(source, "apps/api/src/fixture.test.ts"), [
    "@typescript-eslint/no-floating-promises",
  ]);
  assert.deepEqual(
    errors(
      source.replace("  assert.rejects", "  await assert.rejects"),
      "apps/api/src/fixture.test.ts",
    ),
    [],
  );
});

test("a promise-returning handler where React expects a void callback is rejected", () => {
  const source = `export async function save(): Promise<void> {}
export const button = <button type="button" onClick={save}>Save</button>;`;
  assert.ok(
    errors(source, "packages/web-ui/src/fixture.tsx").includes(
      "@typescript-eslint/no-misused-promises",
    ),
  );
  assert.deepEqual(
    errors(
      source.replace("onClick={save}", "onClick={() => { void save(); }}"),
      "packages/web-ui/src/fixture.tsx",
    ),
    [],
  );
});

test("invalid stylesheet syntax and unknown units fail stylelint", () => {
  for (const source of [
    "a { color: #12345; }",
    "a { width: 12unknownunit; }",
  ]) {
    const run = spawnSync(
      process.execPath,
      [
        stylelint,
        "--stdin",
        "--stdin-filename",
        "packages/web-ui/src/styles/test.css",
      ],
      {
        cwd: root,
        input: source,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.equal(
      run.error,
      undefined,
      run.error?.message ?? "lint process failed",
    );
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
  }
});

test("the required verify job executes lint and scoped format checking", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const verify = workflow.slice(
    workflow.indexOf("  verify:"),
    workflow.indexOf("  postgres-integration:"),
  );
  assert.match(verify, /- run: pnpm lint\s*$/m);
  assert.match(verify, /- run: pnpm format:check\s*$/m);
  const gate = workflow.slice(workflow.indexOf("  required-checks:"));
  assert.match(gate, /needs\.verify\.result/);
});
