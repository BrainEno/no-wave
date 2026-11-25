import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Issue #355: three names (BOT THK, no-wave, 无浪潮 / No Wave) describe the
 * same product. The names document explains them, both READMEs point to it,
 * and the concrete identifiers it cites must still exist, so the explanation
 * cannot drift silently when a name is changed.
 */

const root = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const NAMES = "docs/development/names.md";

test("the names document explains all three names and marks itself active", () => {
  const doc = read(NAMES);
  assert.match(doc, /^Status: active$/m);
  for (const name of ["BOT THK", "no-wave", "无浪潮", "No Wave"]) {
    assert.ok(doc.includes(name), `${NAMES} does not explain "${name}"`);
  }
  assert.match(
    doc,
    /保持不变/,
    "the document must say which existing names are kept",
  );
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
      "- [名称与关系：BOT THK、no-wave、无浪潮](development/names.md) — Status: active",
    ),
    "docs/README.md does not index the names document",
  );
});

test("the concrete identifiers the names document cites still exist", () => {
  const compose = read("compose.yaml");
  assert.match(compose, /container_name: no-wave-postgres/);
  assert.match(compose, /POSTGRES_DB: bot_thk_dev/);
  assert.equal(JSON.parse(read("package.json")).name, "bot-thk");
  assert.match(read(".github/workflows/ci.yml"), /bot-thk-api:ci/);
  assert.match(read("packages/web-ui/src/lib/ui-copy.ts"), /brand: "无浪潮"/);
});
