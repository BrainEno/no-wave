import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { FontManifest } from "../lib/font-assets.ts";
import { staleFontRecipe, verifyFontRecipe } from "./repertoires.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const committed = async () =>
  JSON.parse(
    await readFile(
      join(root, "packages/web-ui/src/styles/fonts/manifest.json"),
      "utf8",
    ),
  ) as FontManifest;

test("the committed font manifest matches the current recipe", async () => {
  const manifest = await committed();
  assert.equal(await staleFontRecipe(manifest, root), null);
  await verifyFontRecipe(manifest, root);
});

test("a manifest cut by an older recipe is reported, not just thrown, so generation can repair it", async () => {
  const manifest = await committed();
  // Swap the ranges of the first two Noto Sans SC faces: the core shard no
  // longer holds the characters the current UI copy puts there, which is what
  // an older recipe leaves behind after a copy change.
  const index = manifest.faces.findIndex(
    (face) => face.source === "noto-sans-sc",
  );
  assert.ok(index >= 0);
  const [first, second] = [manifest.faces[index]!, manifest.faces[index + 1]!];
  assert.equal(second.source, "noto-sans-sc");
  const faces = [...manifest.faces];
  faces[index] = { ...first, unicodeRange: second.unicodeRange };
  faces[index + 1] = { ...second, unicodeRange: first.unicodeRange };
  const stale: FontManifest = { ...manifest, faces };
  assert.equal(await staleFontRecipe(stale, root), "noto-sans-sc/400 700");
  await assert.rejects(
    verifyFontRecipe(stale, root),
    /Stale font recipe for noto-sans-sc\/400 700; run pnpm fonts:generate\./,
  );
});
