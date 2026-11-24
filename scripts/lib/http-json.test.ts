import assert from "node:assert/strict";
import test from "node:test";
import { isRecord, parseJson, readJson } from "./http-json.ts";

test("isRecord narrows non-null non-array objects", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ key: "value" }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord("string"), false);
  assert.equal(isRecord(true), false);
});

test("parseJson returns parsed object for valid JSON objects, and null otherwise", () => {
  assert.deepEqual(parseJson('{"name":"no-wave","active":true}'), {
    name: "no-wave",
    active: true,
  });
  assert.equal(parseJson(""), null);
  assert.equal(parseJson("not json"), null);
  assert.equal(parseJson("[1, 2, 3]"), null);
  assert.equal(parseJson('"plain string"'), null);
  assert.equal(parseJson("null"), null);
  assert.equal(parseJson("42"), null);
});

test("readJson parses Response body as JSON object, returning null on invalid input", async () => {
  const validResponse = new Response('{"status":"ok","code":200}');
  assert.deepEqual(await readJson(validResponse), { status: "ok", code: 200 });

  const invalidResponse = new Response("Bad Request", { status: 400 });
  assert.equal(await readJson(invalidResponse), null);

  const arrayResponse = new Response("[1, 2]");
  assert.equal(await readJson(arrayResponse), null);
});
