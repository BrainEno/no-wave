import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { getUi } from "../../packages/web-ui/src/lib/ui-copy.ts";
import { codepoints, expandUnicodeRange, partitionCharacters, unicodeRange, type FontManifest, type FontAsset } from "../lib/font-assets.ts";
import { FONT_SOURCES, fontSourceReceipt, LATIN_COMMON_CODEPOINTS, type FontSource } from "./font-sources.ts";

const ASCII = Array.from({ length: 95 }, (_, index) => index + 32);
const PUNCTUATION = codepoints("。，、；：？！「」《》（）…—·“”‘’");
const UPPER_SERIF = codepoints("无浪潮进入写作创建账户精选最新作品分类作者搜索我的划线继续阅读全部热门收藏回应关于：，。");
const CJK_TEXT = /[\p{Script=Han}\u2000-\u206f\u3000-\u303f\uff00-\uffef]/gu;

/** Extract actual string/template/JSX text, not comments or identifier names. */
export function literalCjkText(source: string): string {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const fragments: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== "object" || value === null || !("type" in value)) return;
    const node = value as Record<string, unknown>;
    if ((node.type === "StringLiteral" || node.type === "JSXText") && typeof node.value === "string") fragments.push(node.value);
    if (node.type === "TemplateElement" && typeof node.value === "object" && node.value !== null && "cooked" in node.value && typeof node.value.cooked === "string") fragments.push(node.value.cooked);
    for (const child of Object.values(node)) visit(child);
  };
  visit(ast);
  return fragments.join("").match(CJK_TEXT)?.join("") ?? "";
}

export type Repertoires = { sans: number[]; readerUi: number[]; serif: number[]; upper: number[]; reading: number[]; priority: number[] };

export async function applicationRepertoires(root: string): Promise<Repertoires> {
  const sources = await Promise.all([
    "packages/web-ui/src/components/chrome/site-chrome.tsx",
    "packages/web-ui/src/components/auth/sign-in-form.tsx",
    "packages/web-ui/src/lib/notification-feedback.ts",
  ].map(async (path) => literalCjkText(await readFile(join(root, path), "utf8"))));
  const readerSources = await Promise.all([
    "packages/web-ui/src/components/comments/article-comments.tsx",
    "packages/web-ui/src/components/reader/passage-annotations.tsx",
    "packages/web-ui/src/components/reader/reader-tools.tsx",
    "packages/web-ui/src/components/reader/read-aloud.tsx",
  ].map(async (path) => literalCjkText(await readFile(join(root, path), "utf8"))));
  const strings = (value: unknown): string => typeof value === "string" ? value :
    typeof value === "object" && value !== null ? Object.values(value).map(strings).join("") : "";
  const ui = getUi("zh-CN");
  const chromeCopy = strings([ui.brand, ui.rail, ui.nav, ui.bell, ui.footer]);
  const readerCopy = strings(ui.reader);
  const data = JSON.parse(await readFile(new URL("./noto-reading-priority.json", import.meta.url), "utf8")) as { groups: Record<string, string> };
  const groups = Object.values(data.groups).map((range) => expandUnicodeRange(range).filter((point) => point >= 0x3400 && point <= 0x9fff));
  return {
    // UI copy changes automatically update its core; auth prose and display
    // titles do not force the serif to carry every unrelated notification word.
    sans: [...ASCII, ...PUNCTUATION, ...codepoints(literalCjkText(`const copy = ${JSON.stringify(chromeCopy)};`) + sources.join(""))],
    readerUi: codepoints(literalCjkText(`const copy = ${JSON.stringify(readerCopy)};`) + readerSources.join("")),
    serif: [...ASCII, ...PUNCTUATION, ...codepoints(sources[1]!)],
    upper: UPPER_SERIF,
    // Published general-usage priorities, never tailored to an E2E article.
    // Only body 400 gets this shared reading shard; short display titles load
    // smaller leaves instead of pulling a second full reading font at 600.
    reading: groups.slice(0, 5).flat(),
    priority: groups.flat(),
  };
}

export function fontPartitions(all: readonly number[], source: FontSource, weight: FontAsset["weight"], repertoire: Repertoires) {
  if (source.family === "Noto Serif SC") {
    return partitionCharacters(all, weight === "400" ? repertoire.serif : repertoire.upper, 32,
      { reading: weight === "400" ? repertoire.reading : [], priority: repertoire.priority });
  }
  if (source.family === "Noto Sans SC") return partitionCharacters(all, repertoire.sans, 32, { reading: repertoire.readerUi, readingId: "interface", priority: repertoire.priority });
  return partitionCharacters(all, LATIN_COMMON_CODEPOINTS, 128);
}


/** Check the current recipe without downloading or transforming upstream fonts. */
export async function verifyFontRecipe(manifest: FontManifest, root: string): Promise<void> {
  const repertoire = await applicationRepertoires(root);
  for (const source of FONT_SOURCES) {
    for (const weight of fontSourceReceipt(source).weights) {
      const faces = manifest.faces.filter((face) => face.source === source.id && face.weight === weight);
      const all = faces.flatMap((face) => expandUnicodeRange(face.unicodeRange));
      const expected = fontPartitions(all, source, weight, repertoire).map((part) => unicodeRange(part.points));
      if (expected.length !== faces.length || expected.some((range, index) => range !== faces[index]!.unicodeRange)) {
        throw new Error(`Stale font recipe for ${source.id}/${weight}; run pnpm fonts:generate.`);
      }
    }
  }
}
