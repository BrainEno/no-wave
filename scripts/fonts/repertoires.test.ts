import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { FontManifest } from "../lib/font-assets.ts";
import { getUi } from "../../packages/web-ui/src/lib/ui-copy.ts";
import {
  applicationRepertoires,
  staleFontRecipe,
  verifyFontRecipe,
} from "./repertoires.ts";

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

test("sign-in copy moved into ui-copy keeps its Han glyphs in the sans and serif cores", async () => {
  const repertoire = await applicationRepertoires(root);
  const collect = (value: unknown): string =>
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? Object.values(value).map(collect).join("")
        : "";
  const glyphs = [...collect(getUi("zh-CN").account.signIn)]
    .map((character) => character.codePointAt(0)!)
    .filter((point) => /\p{Script=Han}/u.test(String.fromCodePoint(point)));
  // Guard against the test passing vacuously if the copy moves again.
  assert.ok(
    glyphs.length >= 40,
    `expected sign-in Han glyphs, saw ${glyphs.length}`,
  );
  const sans = new Set(repertoire.sans);
  const serif = new Set(repertoire.serif);
  assert.deepEqual(
    glyphs
      .filter((point) => !sans.has(point))
      .map((point) => String.fromCodePoint(point)),
    [],
  );
  assert.deepEqual(
    glyphs
      .filter((point) => !serif.has(point))
      .map((point) => String.fromCodePoint(point)),
    [],
  );
});
