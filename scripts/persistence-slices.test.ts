import assert from "node:assert/strict";
import test from "node:test";

import { checkGeneratedFiles, validateLayout } from "./lib/persistence-slices.ts";

/**
 * These are the cheapest authoritative checks for the first-round split: no
 * database, no server, just the checked-in slice sources against the checked-in
 * generated artifacts and the typed port contract.
 */
test("persistence slice manifest and ownership document are current", async () => {
  const problems = await checkGeneratedFiles();
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("persistence slices own disjoint, complete method sets in both providers", async () => {
  const problems = await validateLayout();
  assert.deepEqual(problems, [], problems.join("\n"));
});
