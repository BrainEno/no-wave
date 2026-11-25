import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import {
  coverParametersForPostId,
  PALETTES,
  renderCover,
} from "../scripts/generate-cover.ts";

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

test("the same post-id always selects the same palette, seed and frame", () => {
  const first = coverParametersForPostId("sample-essay-2026");
  const second = coverParametersForPostId("sample-essay-2026");
  assert.deepEqual(first, second);
  assert.ok(first.palette in PALETTES);
  assert.ok(Number.isInteger(first.seed) && first.seed >= 0 && first.seed < 2 ** 32);
});

test("different post-ids spread across the palette set", () => {
  const palettes = new Set(
    Array.from({ length: 64 }, (_, index) =>
      coverParametersForPostId(`post-${index}`).palette,
    ),
  );
  assert.equal(palettes.size, Object.keys(PALETTES).length);
});

test("rendering is byte-identical for identical parameters and changes with the seed", async () => {
  const parameters = coverParametersForPostId("determinism-check");
  const size = { width: 240, height: 300 };
  const first = await renderCover({ ...size, ...parameters });
  const again = await renderCover({ ...size, ...parameters });
  assert.equal(digest(first), digest(again));

  const otherSeed = await renderCover({ ...size, ...parameters, seed: parameters.seed ^ 1 });
  assert.notEqual(digest(first), digest(otherSeed));
});

test("the rendered JPEG has the requested dimensions and is not a flat fill", async () => {
  const bytes = await renderCover({
    width: 180,
    height: 240,
    ...coverParametersForPostId("dimension-check"),
  });
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 180);
  assert.equal(metadata.height, 240);

  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const distinct = new Set<number>();
  for (let index = 0; index < data.length; index += 97) distinct.add(data[index]!);
  assert.ok(distinct.size > 16, "the cover should contain several tones, not one fill");
});
