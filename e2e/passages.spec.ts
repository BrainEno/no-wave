import { expect, type Browser, type Page } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { publishWork, selectPartOf } from "./support/works.ts";
import { cancellations, installEngine, spokenTexts } from "./support/speech.ts";

/**
 * 划线 — marking a passage, in a real browser.
 *
 * The whole feature lives between a selection and a keystroke, and no cheaper
 * layer can see any of it: the server never renders a mark (it is the reader's
 * own, in their own browser), and the painting is done by the Custom Highlight
 * API, which is not part of the DOM at all — a marked paragraph and an
 * unmarked one have identical markup. So what this file asserts is the reader's
 * half: that a selection offers 划线, that the mark appears on the page and on
 * the shelf, that it is still there after a reload, and that 删除 takes it away
 * again.
 *
 * The one internal it looks at is `CSS.highlights`, which is the only
 * observable trace of the paint: the registry the browser keeps for the
 * highlight pseudo-elements. Everything else is a button, a row or a line of
 * text a reader can see.
 *
 * What a passage *is* — how it is found again after the work is edited, how
 * long it may be, what happens when the shelf is full — is decided in
 * `lib/passages.ts` and covered there, without a browser (ADR 0021).
 *
 * The two sharing journeys are here for the same reason as the rest: what a
 * share *is* — a link, carrying the work's own words and nothing else — is a
 * fact about the reader's browser, and no cheaper layer can see a link being
 * followed by someone who has never marked anything.
 *
 * The last two journeys borrow the fake speech engine from `support/speech.ts`,
 * for the same reason `read-aloud.spec.ts` does: a headless browser has no
 * voices, and what is being asserted is which words reached the engine.
 */

const FIRST_PARAGRAPH = "那年冬天，渡口的船停了，第一句留给划线。";
const SECOND_PARAGRAPH = "河面很静，静得能听见冰，第二句留给批注。";
const TITLE_PREFIX = "划线验证";
const MARK = "nw-passage";
const MARK_NOTE = "nw-passage-note";
const MARK_SHARED = "nw-passage-shared";
/** `hello`, in base64url: five letters this work does not contain. */
const GONE_FRAGMENT = "#nw-p=0.5.aGVsbG8";

let slug = "";

test.beforeAll(async ({ request }) => {
  const work = await publishWork(request, `${TITLE_PREFIX} ${Date.now().toString(36)}`, [FIRST_PARAGRAPH, SECOND_PARAGRAPH]);
  slug = work.slug;
});

/** The names the browser is painting. `HighlightRegistry` is map-like at runtime; the DOM typings omit `keys()`. */
const highlights = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(CSS.highlights as unknown as { keys(): IterableIterator<string> }).keys()]);
const stored = (page: Page, key: string): Promise<unknown[]> =>
  page.evaluate((name) => JSON.parse(window.localStorage.getItem(name) ?? "[]") as unknown[], key);

test("a marked passage is painted, listed and kept on this device across a reload", async ({ page }) => {
  await page.goto(`/articles/${slug}`);
  const shelf = page.locator("[data-passage-shelf]");
  await expect(shelf, "the shelf is there before anything is marked").toBeVisible({ timeout: 60_000 });
  await expect(shelf.locator("li")).toHaveCount(0);
  expect(await highlights(page)).not.toContain(MARK);

  await selectPartOf(page, page.locator("#nw-article p[data-block]").first());
  await expect(page.locator("[data-passage-tools]"), "selecting text offers to mark it").toBeVisible({ timeout: 60_000 });
  await page.locator("[data-passage-mark]").click();

  // Painted, listed, and named on the shelf by the words the reader chose.
  await expect(shelf.locator("li")).toHaveCount(1, { timeout: 60_000 });
  await expect(shelf.locator("li").first()).toContainText(FIRST_PARAGRAPH.slice(0, 8));
  expect(await highlights(page), "the passage is painted").toContain(MARK);
  await expect(page.locator("[data-passages] [role=status]")).toContainText("已保存在这台设备上");

  // The durable outcome: it survives a reload, because it belongs to the
  // reader's browser and not to the page that happens to be open.
  await page.reload();
  await expect(page.locator("[data-passage-shelf] li")).toHaveCount(1, { timeout: 60_000 });
  expect(await highlights(page)).toContain(MARK);
  const saved = await stored(page, `nw-passages-v1:${slug}`);
  expect(saved.length, "one passage is kept, under this work's own key").toBe(1);
});

test("a note is kept beside the passage it belongs to", async ({ page }) => {
  await page.goto(`/articles/${slug}`);
  await expect(page.locator("[data-passage-shelf]")).toBeVisible({ timeout: 60_000 });

  await selectPartOf(page, page.locator("#nw-article p[data-block]").nth(1));
  await page.locator("[data-passage-note]").click();
  // The note dialog, by name: the shelf has a share dialog with the same skin.
  const dialog = page.locator("[data-passage-dialog='note']");
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await page.locator("[data-passage-input]").fill("这句我读了两遍。");
  await page.locator("[data-passage-save]").click();

  await expect(page.locator("[data-passage-shelf] li")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator("[data-passage-shelf] .nw-passage-note")).toHaveText("这句我读了两遍。");
  expect(await highlights(page), "a passage with a note is painted as one with a note").toContain(MARK_NOTE);

  // Editing the note changes it, and does not add a second mark.
  await page.locator("[data-passage-shelf] li").first().getByRole("button", { name: "修改" }).click();
  await page.locator("[data-passage-input]").fill("还是这句。");
  await page.locator("[data-passage-save]").click();
  await expect(page.locator("[data-passage-shelf] .nw-passage-note")).toHaveText("还是这句。", { timeout: 60_000 });
  await expect(page.locator("[data-passage-shelf] li")).toHaveCount(1);

  await page.reload();
  await expect(page.locator("[data-passage-shelf] .nw-passage-note")).toHaveText("还是这句。", { timeout: 60_000 });
});

test("removing a mark takes it off the page and out of the browser", async ({ page }) => {
  await page.goto(`/articles/${slug}`);
  await expect(page.locator("[data-passage-shelf]")).toBeVisible({ timeout: 60_000 });

  await selectPartOf(page, page.locator("#nw-article p[data-block]").first());
  await page.locator("[data-passage-mark]").click();
  await expect(page.locator("[data-passage-shelf] li")).toHaveCount(1, { timeout: 60_000 });

  await page.locator("[data-passage-shelf] li").first().getByRole("button", { name: "删除" }).click();

  await expect(page.locator("[data-passage-shelf] li"), "the shelf is empty again").toHaveCount(0, { timeout: 60_000 });
  expect(await highlights(page), "and nothing is painted any more").not.toContain(MARK);
  expect(await stored(page, `nw-passages-v1:${slug}`), "and the browser is not left holding it").toEqual([]);
});

test("a marked passage can be read on its own, and 停止 ends it", async ({ page }) => {
  await installEngine(page, 900);
  await page.goto(`/articles/${slug}`);
  await expect(page.locator("[data-passage-shelf]")).toBeVisible({ timeout: 60_000 });

  await selectPartOf(page, page.locator("#nw-article p[data-block]").first());
  await page.locator("[data-passage-mark]").click();
  const item = page.locator("[data-passage-shelf] li").first();
  await expect(item).toHaveCount(1, { timeout: 60_000 });
  const quote = (await item.locator(".nw-passage-quote").textContent())?.trim() ?? "";
  expect(quote.length).toBeGreaterThan(0);

  const read = item.getByRole("button", { name: "朗读这段" });
  await expect(read).toBeVisible();
  await read.click();

  // The words the reader marked, and only those, are what gets said.
  await expect(async () => {
    expect(await spokenTexts(page)).toEqual([quote]);
  }).toPass({ timeout: 60_000 });
  await expect(item.getByRole("button", { name: "停止" }), "the same button ends it").toBeVisible();

  await item.getByRole("button", { name: "停止" }).click();
  expect(await cancellations(page), "停止 reaches the engine").toBeGreaterThan(0);
  await expect(item.getByRole("button", { name: "朗读这段" })).toBeVisible();
});

test("reading one passage takes the voice from a reading of the whole work", async ({ page }) => {
  await installEngine(page, 900);
  await page.goto(`/articles/${slug}`);
  await expect(page.locator("[data-passage-shelf]")).toBeVisible({ timeout: 60_000 });

  await selectPartOf(page, page.locator("#nw-article p[data-block]").first());
  await page.locator("[data-passage-mark]").click();
  const item = page.locator("[data-passage-shelf] li").first();
  await expect(item).toHaveCount(1, { timeout: 60_000 });
  const quote = (await item.locator(".nw-passage-quote").textContent())?.trim() ?? "";

  // The whole work is being read...
  await page.locator("[data-read-aloud]").getByRole("button", { name: "朗读" }).click();
  await expect(page.locator("[data-read-aloud]").getByRole("button", { name: "暂停" })).toBeVisible({ timeout: 60_000 });

  // ...and then the reader asks for one passage.
  await item.getByRole("button", { name: "朗读这段" }).click();

  // A browser has one voice: the article's reading is over, and its control
  // says so instead of sitting on 暂停 for something nobody can hear.
  await expect(page.locator("[data-read-aloud]").getByRole("button", { name: "朗读" }), "the article's control is back at rest")
    .toBeVisible({ timeout: 60_000 });
  await expect(item.getByRole("button", { name: "停止" })).toBeVisible();
  expect(await spokenTexts(page)).toContain(quote);
});

test("a marked passage can be shared, and the link marks it for a reader who has marked nothing", async ({ page, browser }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/articles/${slug}`);
  await expect(page.locator("[data-passage-shelf]")).toBeVisible({ timeout: 60_000 });

  await selectPartOf(page, page.locator("#nw-article p[data-block]").first());
  await page.locator("[data-passage-mark]").click();
  const item = page.locator("[data-passage-shelf] li").first();
  await expect(item).toHaveCount(1, { timeout: 60_000 });
  const quote = (await item.locator(".nw-passage-quote").textContent())?.trim() ?? "";
  expect(quote.length).toBeGreaterThan(0);

  // 分享 writes the passage into a link on the work's own address.
  await item.getByRole("button", { name: "分享" }).click();
  const link = page.locator("[data-passage-share-url]");
  await expect(link).toBeVisible({ timeout: 60_000 });
  const shared = await link.inputValue();
  expect(shared).toContain(`/articles/${slug}#`);
  await page.locator("[data-passage-share-copy]").click();
  await expect(page.locator("[data-passages] [role='status']")).toContainText("链接已复制");

  // A reader who has never marked anything follows it, in a browser of their own.
  const reader = await browser.newContext();
  const readerPage = await reader.newPage();
  await readerPage.goto(shared);

  const card = readerPage.locator("[data-passage-shared]");
  await expect(card, "the passage arrives with the reader").toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText(quote.slice(0, 8));
  await expect(async () => {
    expect(await highlights(readerPage)).toContain(MARK_SHARED);
  }).toPass({ timeout: 60_000 });
  // …but it is not theirs until they say so: a link does not write to a shelf.
  await expect(readerPage.locator("[data-passage-shelf] li")).toHaveCount(0);
  expect(await stored(readerPage, `nw-passages-v1:${slug}`)).toEqual([]);

  await readerPage.locator("[data-passage-shared-keep]").click();
  await expect(readerPage.locator("[data-passage-shelf] li")).toHaveCount(1, { timeout: 60_000 });
  expect(await highlights(readerPage), "it is one of their own marks now").toContain(MARK);
  expect(await highlights(readerPage)).not.toContain(MARK_SHARED);
  expect(await stored(readerPage, `nw-passages-v1:${slug}`), "and it is kept").toHaveLength(1);

  // The address is clean, so a reload does not ask the same question twice.
  await expect(readerPage.locator("[data-passage-shared]")).toHaveCount(0);
  await readerPage.reload();
  await expect(readerPage.locator("[data-passage-shelf] li")).toHaveCount(1, { timeout: 60_000 });
  await expect(readerPage.locator("[data-passage-shared]")).toHaveCount(0);
  await reader.close();
});

test("a shared passage whose words are gone says so, and marks nothing", async ({ page }) => {
  await page.goto(`/articles/${slug}${GONE_FRAGMENT}`);
  const card = page.locator("[data-passage-shared]");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("已经不在作品里");
  // Nothing is painted over words the work does not contain: a link may carry
  // any sentence a reader cares to write into it.
  expect(await highlights(page)).not.toContain(MARK_SHARED);
  await expect(page.locator("[data-passage-shared-keep]"), "and there is nothing to keep").toHaveCount(0);
  await expect(page.locator("[data-passage-shelf] li")).toHaveCount(0);

  await page.locator("[data-passage-shared-dismiss]").click();
  await expect(card).toHaveCount(0);
  expect(new URL(page.url()).hash, "the answered link is taken out of the address").toBe("");
});
