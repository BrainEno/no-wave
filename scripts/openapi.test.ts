import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPENAPI_FILE,
  checkOpenApiFile,
  expectedDocument,
  readCheckedInDocument,
  writeOpenApiFile,
} from "./lib/openapi-contract.ts";

/**
 * The checked-in contract against the one the API generates.
 *
 * `pnpm openapi:check` is the command a contributor runs; these are the same
 * assertions in the test suite, so a contract change that forgets to regenerate
 * the file fails CI rather than shipping a document that describes the previous
 * release. The temporary-root cases exist because a byte comparison that never
 * reports a difference would pass this suite and be useless in practice.
 */

test("the checked-in OpenAPI document matches the API's own route table", async () => {
  const problems = await checkOpenApiFile();
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the checked-in document is parseable OpenAPI 3.1 with paths", async () => {
  const text = await readCheckedInDocument();
  assert.ok(text !== null, `${OPENAPI_FILE} should exist`);
  const document = JSON.parse(text) as Record<string, unknown>;
  assert.equal(document.openapi, "3.1.0");
  const paths = document.paths as Record<string, unknown>;
  assert.ok(Object.keys(paths).length > 0);
  const info = document.info as Record<string, unknown>;
  assert.equal(info.title, "No Wave REST API");
});

test("a stale copy is reported with the first differing line", async () => {
  const root = await mkdtemp(join(tmpdir(), "openapi-stale-"));
  try {
    await writeOpenApiFile(root);
    assert.deepEqual(await checkOpenApiFile(root), []);

    const path = join(root, OPENAPI_FILE);
    const current = await readFile(path, "utf8");
    await writeFile(path, current.replace('"openapi": "3.1.0"', '"openapi": "3.1.1"'), "utf8");

    const problems = await checkOpenApiFile(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /stale at line 2/);
    assert.match(problems[0] ?? "", /openapi:write/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing copy is a problem, not an empty pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "openapi-missing-"));
  try {
    const problems = await checkOpenApiFile(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writing is idempotent and byte-identical to the expected document", async () => {
  const root = await mkdtemp(join(tmpdir(), "openapi-write-"));
  try {
    const first = await writeOpenApiFile(root);
    const second = await writeOpenApiFile(root);
    assert.equal(first, OPENAPI_FILE);
    assert.equal(second, OPENAPI_FILE);
    assert.equal(await readFile(join(root, first), "utf8"), expectedDocument());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
