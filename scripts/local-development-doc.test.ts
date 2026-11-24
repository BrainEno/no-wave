import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url).pathname;
const guide = readFileSync(
  resolve(root, "docs/development/local-development.md"),
  "utf8",
);

test("the local-development operational guide has unique sequential sections and archives its historical narrative", () => {
  const numbered = [...guide.matchAll(/^## (\d+)\. /gm)].map((match) =>
    Number(match[1]),
  );
  assert.ok(numbered.length >= 7, "the guard cannot pass on an empty guide");
  assert.deepEqual(
    numbered,
    numbered.map((_, index) => index + 1),
  );
  assert.doesNotMatch(
    guide,
    /^## \d+\. (?:What was missing before|Defect found while verifying the chain)$/m,
  );
  const archive = "docs/audit/local-development-history.md";
  assert.ok(guide.includes("../audit/local-development-history.md"));
  assert.ok(existsSync(resolve(root, archive)));
  const history = readFileSync(resolve(root, archive), "utf8");
  assert.match(history, /9f4da47/);
  for (const text of [
    "## 7. Troubleshooting",
    "## 8. Known limits",
    "## 9. Durable notification verification",
  ])
    assert.ok(guide.includes(text));
});

test("both README publishing-visibility links follow the renumbered operational heading", () => {
  const heading = /^### ([\d.]+ Publishing visibility without mail)$/m.exec(
    guide,
  )?.[1];
  assert.ok(heading);
  const fragment = heading.toLowerCase().replace(/\./g, "").replace(/ /g, "-");
  for (const filename of ["README.md", "README.zh-CN.md"]) {
    const readme = readFileSync(resolve(root, filename), "utf8");
    const link =
      /docs\/development\/local-development\.md#([^)]*publishing-visibility-without-mail)/.exec(
        readme,
      )?.[1];
    assert.equal(
      link,
      fragment,
      `${filename} still points to an obsolete heading`,
    );
  }
});
