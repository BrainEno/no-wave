import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Issue #355: the two names in use (no-wave for the project, 无浪潮 / No Wave
 * for readers) are explained in one document. Both READMEs point to it, and
 * the concrete identifiers it cites must still exist, so the explanation cannot
 * drift silently when a name is changed.
 */

const root = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const NAMES = "docs/development/names.md";

test("the names document explains both names in use and marks itself active", () => {
  const doc = read(NAMES);
  assert.match(doc, /^Status: active$/m);
  for (const name of ["no-wave", "无浪潮", "No Wave", "@no-wave/*"]) {
    assert.ok(doc.includes(name), `${NAMES} does not explain "${name}"`);
  }
  assert.match(
    doc,
    /有意保持不变/,
    "the document must say which strings are kept",
  );
});

test("the READMEs and the documentation index do not use the retired project name", () => {
  for (const path of ["README.md", "README.zh-CN.md", "docs/README.md"]) {
    assert.doesNotMatch(
      read(path),
      /bot[-_ ]?thk/i,
      `${path} uses the retired name`,
    );
  }
});

test("both READMEs link to the names document", () => {
  for (const readme of ["README.md", "README.zh-CN.md"]) {
    assert.ok(
      read(readme).includes(`(${NAMES})`),
      `${readme} does not link ${NAMES}`,
    );
  }
});

test("the documentation index lists the names document under development", () => {
  assert.ok(
    read("docs/README.md").includes(
      "- [名称与关系：no-wave 与无浪潮](development/names.md) — Status: active",
    ),
    "docs/README.md does not index the names document",
  );
});

test("the concrete identifiers the names document cites still exist", () => {
  const compose = read("compose.yaml");
  assert.match(compose, /container_name: no-wave-postgres/);
  assert.match(compose, /POSTGRES_DB: no_wave_dev/);
  assert.equal(JSON.parse(read("package.json")).name, "no-wave");
  assert.match(read(".github/workflows/ci.yml"), /no-wave-api:ci/);
  assert.match(read("packages/web-ui/src/lib/ui-copy.ts"), /brand: "无浪潮"/);
});
