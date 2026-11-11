import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** Test the same configuration and inline-suppression policy used by CI. */
function lint(
  source: string,
  filename = "packages/web-ui/src/lint-fixture.tsx",
): Result {
  const run = spawnSync(
    process.execPath,
    [
      eslint,
      "--flag",
      "unstable_native_nodejs_ts_config",
      "--no-inline-config",
      "--stdin",
      "--stdin-filename",
      filename,
      "--format",
      "json",
    ],
    { cwd: root, input: source, encoding: "utf8", timeout: 20_000 },
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

test("rule enforcement applies to route, shared UI and script paths", () => {
  const source = 'export const image = <img src="/a" />;';
  for (const path of [
    "apps/web-rr/app/fixture.tsx",
    "packages/web-ui/src/fixture.tsx",
    "scripts/fixture.tsx",
    "e2e/fixture.tsx",
  ]) {
    assert.ok(errors(source, path).includes("jsx-a11y/alt-text"), path);
  }
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
