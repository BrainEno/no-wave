import assert from "node:assert/strict";
import test from "node:test";

import { contentReferencesMediaAsset } from "./media-reference-pattern.ts";

/**
 * #243: "mentions the id" and "references the asset" are different questions.
 *
 * The delete-time backstop used to answer both with one substring test, and then
 * fabricate the `content` its own extractor needed, so prose counted as a
 * reference. This predicate is the answer the scan, the badge and the delete now
 * share, so it is worth pinning on its own: it is cheap to get subtly wrong (a
 * URL in a JSON string, an uppercase id, a bare id in a code block) and the cost
 * of getting it wrong is an image nobody can ever delete — or one deleted out of
 * a published work.
 */
const ASSET = "3f2b6c2e-0d1a-4c3a-9a6f-1c1f0b7d2e44";
const OTHER = "11111111-1111-4111-8111-111111111111";

test("a URL that names the asset is a reference, in every address shape", () => {
  const shapes = [
    `/api/v1/media/${ASSET}`,
    `/api/media/${ASSET}`,
    `/media/${ASSET}`,
    `https://cdn.example.test/media/${ASSET}/cover.webp`,
  ];
  for (const src of shapes) {
    const blocks = JSON.stringify([{ id: "i1", type: "image", src, alt: "" }]);
    assert.equal(contentReferencesMediaAsset(blocks, ASSET), true, src);
  }
  // Parsed blocks count too: PostgreSQL hands the store a string, but nothing
  // should depend on which of the two arrives.
  assert.equal(contentReferencesMediaAsset([{ type: "image", src: `/media/${ASSET}` }], ASSET), true);
});

test("a bare id in prose is not a reference", () => {
  const bodies: unknown[] = [
    JSON.stringify([{ id: "p1", type: "paragraph", text: `调试记录 ID: ${ASSET}` }]),
    JSON.stringify([{ id: "c1", type: "code", language: "text", code: `asset=${ASSET}` }]),
    `plain text mentioning ${ASSET} with no media path at all`,
    `/something-else/${ASSET}`,
  ];
  for (const body of bodies) {
    assert.equal(contentReferencesMediaAsset(body, ASSET), false, String(body));
  }
});

test("the comparison is by id, case-insensitively, and cannot be fooled by another asset", () => {
  assert.equal(contentReferencesMediaAsset(`/media/${ASSET.toUpperCase()}`, ASSET), true);
  assert.equal(contentReferencesMediaAsset(`/media/${ASSET}`, ASSET.toUpperCase()), true);
  assert.equal(contentReferencesMediaAsset(`/media/${OTHER}`, ASSET), false, "a different asset is a different reference");
  // A prefix of the id is not the id: the pattern only matches a whole UUID.
  assert.equal(contentReferencesMediaAsset(`/media/${ASSET.slice(0, 8)}`, ASSET), false);
  assert.equal(contentReferencesMediaAsset("", ASSET), false);
  assert.equal(contentReferencesMediaAsset(null, ASSET), false);
});
