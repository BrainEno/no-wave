import { expect, test, type Page } from "@playwright/test";
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
 * The last two journeys borrow the fake speech engine from `support/speech.ts`,
 * for the same reason `read-aloud.spec.ts` does: a headless browser has no
 * voices, and what is being asserted is which words reached the engine.
 */

const FIRST_PARAGRAPH = "那年冬天，渡口的船停了，第一句留给划线。";
const SECOND_PARAGRAPH = "河面很静，静得能听见冰，第二句留给批注。";
const TITLE_PREFIX = "划线验证";
const MARK = "nw-passage";
const MARK_NOTE = "nw-passage-note";

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
  const dialog = page.locator(".nw-passage-dialog");
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
