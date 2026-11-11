import assert from "node:assert/strict";
import test from "node:test";

import {
  NotionBundleError,
  articleWriteBody,
  draftDigest,
  emptyNotionSeedState,
  groupNotionWorks,
  idempotencyKeyFor,
  parseNotionBundle,
  parseNotionSeedState,
  planNotionSeed,
  type NotionBundle,
  type NotionBundlePage,
} from "./notion-bundle.ts";
import { articleDraftFromNotionPage } from "../../apps/api/src/application/notion-interchange.ts";

const text = (content: string) => ({
  type: "text",
  plain_text: content,
  href: null,
  text: { content, link: null },
  annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" },
});

const paragraph = (content: string) => ({
  object: "block",
  id: `b-${content.slice(0, 4)}`,
  type: "paragraph",
  has_children: false,
  paragraph: { rich_text: [text(content)], color: "default" },
});

function page(id: string, title: string, extra: Record<string, unknown> = {}, blocks = [paragraph("正文")]): NotionBundlePage {
  return {
    id,
    properties: {
      Page: { type: "title", title: [text(title)] },
      Slug: { type: "rich_text", rich_text: [] },
      Excerpt: { type: "rich_text", rich_text: [] },
      Date: { type: "date", date: null },
      Published: { type: "checkbox", checkbox: false },
      Tags: { type: "multi_select", multi_select: [] },
      ...(extra as Record<string, never>),
    },
    blocks,
  };
}

const bundle = (pages: NotionBundlePage[]): NotionBundle => ({
  version: 1,
  database: { id: "ds-1", title: "Bottom Think" },
  pages,
});

test("a bundle is read strictly: a truncated export is a fixable error, not a silent empty import", () => {
  assert.throws(() => parseNotionBundle({ version: 2, pages: [] }), NotionBundleError);
  assert.throws(() => parseNotionBundle({ version: 1, pages: "no" }), NotionBundleError);
  assert.throws(() => parseNotionBundle({ version: 1, pages: [{ id: "", properties: {}, blocks: [] }] }), NotionBundleError);
  assert.throws(() => parseNotionBundle({ version: 1, pages: [{ id: "p", properties: {}, blocks: {} }] }), NotionBundleError);

  const parsed = parseNotionBundle({ version: 1, pages: [{ id: "p", properties: {}, blocks: [] }] });
  assert.deepEqual(parsed.database, { id: "", title: null });
  assert.equal(parsed.pages.length, 1);
});

test("the translation relation pairs two pages into one work, whichever side carries it", () => {
  // Only the Chinese page carries the relation, as in the real database.
  const zh = page("zh-1", "飞行器", {
    Date: { type: "date", date: { start: "2026-05-13" } },
    Published: { type: "checkbox", checkbox: true },
    English: { type: "relation", relation: [{ id: "en-1" }] },
  });
  const en = page("en-1", "Aircraft", {}, [paragraph("A head is opened")]);
  const { works, issues } = groupNotionWorks([zh, en]);

  assert.equal(works.length, 1, "a translation is not a second work");
  assert.equal(works[0]!.key, "zh-1");
  assert.equal(works[0]!.primary.id, "zh-1", "the dated page is the work");
  assert.deepEqual(works[0]!.translations.map((entry) => [entry.locale, entry.page.id]), [["en", "en-1"]]);
  assert.deepEqual(issues, []);

  // Reversing the input cannot change the answer: the walk is undirected.
  const reversed = groupNotionWorks([en, zh]);
  assert.equal(reversed.works[0]!.primary.id, "zh-1");
  assert.equal(reversed.works[0]!.translations[0]?.page.id, "en-1");
});

test("with no date, the longer body is the work — deterministically", () => {
  const longer = page("a-long", "长", {}, [paragraph("一"), paragraph("二"), paragraph("三")]);
  const shorter = page("a-short", "短", { English: { type: "relation", relation: [{ id: "a-long" }] } }, [paragraph("一")]);
  const { works } = groupNotionWorks([shorter, longer]);
  assert.equal(works[0]!.primary.id, "a-long");
});

test("a plan creates what is new, skips what is unchanged and updates what changed", () => {
  const wall = page("wall-1", "墙壁", {
    Date: { type: "date", date: { start: "2026-10-08" } },
    Published: { type: "checkbox", checkbox: true },
    Tags: { type: "multi_select", multi_select: [{ name: "诗歌" }] },
  });
  const { works } = groupNotionWorks([wall]);

  const fresh = planNotionSeed({ works, state: emptyNotionSeedState() });
  assert.equal(fresh.works.length, 1);
  const first = fresh.works[0]!.primary;
  assert.equal(first.articleId, null);
  assert.equal(first.slug, "qiangbi");
  assert.equal(first.unchanged, false);
  assert.equal(first.draft.workType, "poetry");
  assert.equal(first.draft.publish, true);

  const stored = {
    version: 1 as const,
    pages: { "wall-1": { articleId: "art-9", slug: "qiangbi", locale: "zh-CN", digest: first.digest, syncedAt: "2026-11-03T00:00:00.000Z" } },
  };
  const again = planNotionSeed({ works, state: parseNotionSeedState(stored) });
  assert.equal(again.works[0]!.primary.unchanged, true, "an untouched page is not rewritten");
  assert.equal(again.works[0]!.primary.articleId, "art-9");
  assert.equal(again.works[0]!.primary.slug, "qiangbi", "the address the store chose is reused, not re-derived");

  const edited = groupNotionWorks([
    { ...wall, blocks: [paragraph("改过的一句")] },
  ]).works;
  const changed = planNotionSeed({ works: edited, state: parseNotionSeedState(stored) });
  assert.equal(changed.works[0]!.primary.unchanged, false);
});

test("a page that cannot be an article is refused with its reasons, not imported empty", () => {
  const empty = page("blank-1", "空白", {}, []);
  const { works } = groupNotionWorks([empty]);
  const plan = planNotionSeed({ works, state: emptyNotionSeedState() });
  assert.equal(plan.works.length, 0);
  assert.equal(plan.refused.length, 1);
  assert.equal(plan.refused[0]!.title, "空白");
  assert.deepEqual(plan.refused[0]!.issues.map((issue) => issue.code), ["empty-body"]);
});

test("a blank English page is reported on the work instead of becoming an empty edition", () => {
  const zh = page("zh-2", "飞行器", {
    Date: { type: "date", date: { start: "2026-05-13" } },
    English: { type: "relation", relation: [{ id: "en-2" }] },
  });
  const en = page("en-2", "Aircraft", {}, []);
  const { works } = groupNotionWorks([zh, en]);
  const plan = planNotionSeed({ works, state: emptyNotionSeedState() });
  assert.equal(plan.works[0]!.translations.length, 0);
  assert.ok(plan.works[0]!.primary.issues.some((issue) => issue.code === "empty-body" && issue.detail.startsWith("en:")));
});

test("the digest follows what a reader sees, not the document's internal ids", () => {
  const wall = page("wall-2", "墙壁", { Date: { type: "date", date: { start: "2026-10-08" } } }, [paragraph("一"), paragraph("二")]);
  const base = articleDraftFromNotionPage({ page: wall, blocks: wall.blocks });
  assert.ok(base.draft);
  const digest = draftDigest(base.draft);

  const renumbered = {
    ...base.draft,
    contentBlocks: base.draft.contentBlocks.map((block, index) => ({ ...block, id: `other-${index}` })),
  };
  assert.equal(draftDigest(renumbered), digest, "a regenerated block id is not a change");

  const reordered = { ...base.draft, contentBlocks: [...base.draft.contentBlocks].reverse() };
  assert.notEqual(draftDigest(reordered), digest, "order is content");

  const retagged = { ...base.draft, tags: ["诗歌", "小说"] };
  const swapped = { ...base.draft, tags: ["小说", "诗歌"] };
  assert.equal(draftDigest(retagged), draftDigest(swapped), "tag order is not a change");
});

test("the write body is the REST contract, with the locale stated rather than defaulted", () => {
  const wall = page("wall-3", "墙壁", { Date: { type: "date", date: { start: "2026-10-08" } } });
  const draft = articleDraftFromNotionPage({ page: wall, blocks: wall.blocks }).draft!;
  const body = articleWriteBody(draft, ["tag-1"]);
  assert.equal(body.locale, "zh-CN");
  assert.equal(body.contentBlocksVersion, 1);
  assert.equal(body.workType, "other");
  assert.equal(body.publish, false);
  assert.deepEqual(body.tagIds, ["tag-1"]);
  assert.equal("categoryIds" in body, false, "categories are the author's editorial choice, not the importer's");
  assert.equal("tagIds" in articleWriteBody(draft), false, "no tags means no tag field, not an empty one");
});

test("the idempotency key belongs to the page, so a re-run cannot duplicate it", () => {
  assert.equal(idempotencyKeyFor("3c8315cb-0ec8-80bc-8574-e433a983d366"), "notion-seed:3c8315cb-0ec8-80bc-8574-e433a983d366");
  assert.notEqual(idempotencyKeyFor("a"), idempotencyKeyFor("b"));
});

test("a corrupt state file is treated as a first run, not as a crash", () => {
  assert.deepEqual(parseNotionSeedState(null), emptyNotionSeedState());
  assert.deepEqual(parseNotionSeedState({ version: 1, pages: { x: { articleId: 5 } } }), emptyNotionSeedState());
  const kept = parseNotionSeedState({
    version: 1,
    pages: { x: { articleId: "a", slug: "s", locale: "en", digest: "d", syncedAt: "t" }, y: "nonsense" },
  });
  assert.deepEqual(Object.keys(kept.pages), ["x"]);
});

test("a bundle round-trips through JSON unchanged", () => {
  const original = bundle([
    page("p1", "墙壁", { Date: { type: "date", date: { start: "2026-10-08" } } }),
    page("p2", "飞行器", { English: { type: "relation", relation: [{ id: "p3" }] } }),
    page("p3", "Aircraft", {}, []),
  ]);
  assert.deepEqual(parseNotionBundle(JSON.parse(JSON.stringify(original))), original);
});

test("a bundle cannot contain duplicate source page identities", () => {
  assert.throws(() => parseNotionBundle(bundle([page("duplicate", "一"), page("duplicate", "二")])), /duplicate page IDs/);
});
