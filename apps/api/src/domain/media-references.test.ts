import assert from "node:assert/strict";
import test from "node:test";
import { MEDIA_SRC_PATTERN, collectMediaAssetIds } from "./media-references.ts";

const ID = "11111111-1111-4111-8111-111111111111";

/**
 * The writer's half of the media-deletion protocol (issue #156).
 *
 * Both providers lock the assets a save mentions before writing, so the extractor
 * decides which rows a save is able to protect. Missing one is the failure that
 * matters: the delete would not lock it, and a live reference could be removed.
 * Over-counting only locks a row nobody uses.
 */
test("every address a client can store is recognised as a reference", () => {
  // The three the API has to serve: its own route, the Web app's relay, and the
  // absolute URL a Flutter client stores.
  const addresses = [
    `/api/v1/media/${ID}`,
    `/api/media/${ID}`,
    `/media/${ID}`,
    `https://api.example.test/api/v1/media/${ID}`,
    `http://127.0.0.1:4000/api/media/${ID}?v=2`,
    // Uppercase hex is a valid uuid and a stored URL is not normalised.
    `/api/v1/media/${ID.toUpperCase()}`,
  ];
  for (const address of addresses) {
    assert.deepEqual(collectMediaAssetIds([{ type: "image", src: address }]), [ID], address);
  }
});

test("the extraction is a walk, not a search of the serialized body", () => {
  // Nested blocks, arrays of paragraphs, and the same image twice.
  const body = [
    { type: "paragraph", children: [{ type: "text", text: `see /media/${ID}` }] },
    { type: "image", src: `/api/v1/media/${ID}` },
    { type: "paragraph", children: [{ type: "text", text: "no image here" }] },
  ];
  assert.deepEqual(collectMediaAssetIds(body), [ID], "one id however often it appears");
  assert.deepEqual(collectMediaAssetIds({ a: [{ b: `…/media/${ID}` }] }), [ID]);
});

test("content with no references, or no content at all, locks nothing", () => {
  for (const empty of [null, undefined, "", "plain text", [], {}, 0, false]) {
    assert.deepEqual(collectMediaAssetIds(empty), [], JSON.stringify(empty));
  }
  // A uuid that is not inside a `/media/` path is not an address of a stored
  // object, so it is not a reference to protect.
  assert.deepEqual(collectMediaAssetIds(`/assets/${ID}`), []);
});

test("a cyclic or absurdly deep body answers instead of hanging a save", () => {
  const cyclic = { type: "paragraph" };
  cyclic.self = cyclic;
  assert.deepEqual(collectMediaAssetIds(cyclic), []);
  let deep = `/media/${ID}`;
  for (let index = 0; index < 100; index += 1) deep = { child: deep };
  // Beyond the depth cap the reference is not found; the save still completes,
  // and the full scan still sees the committed row.
  assert.deepEqual(collectMediaAssetIds(deep), []);
});

test("the exported pattern stays global and case-insensitive", () => {
  // `matchAll` requires `/g`; a non-global pattern would silently keep only the
  // first reference on a page. Both callers share this object.
  assert.ok(MEDIA_SRC_PATTERN.flags.includes("g"));
  assert.ok(MEDIA_SRC_PATTERN.flags.includes("i"));
  const matches = [...`/media/${ID} and /media/${ID}`.matchAll(MEDIA_SRC_PATTERN)];
  assert.equal(matches.length, 2);
});
