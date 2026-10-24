import test from "node:test";
import assert from "node:assert/strict";
import { submitDraftToMockApi } from "./spike-api.mjs";

test("mock API accepts a valid title", async () => {
  const response = await submitDraftToMockApi("A valid title");
  assert.equal(response.ok, true);
  assert.equal(response.status, 201);
});

test("mock API exposes a deterministic server failure for UI testing", async () => {
  const response = await submitDraftToMockApi("simulate-server-error");
  assert.equal(response.ok, false);
  assert.equal(response.status, 503);
});
