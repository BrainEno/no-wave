import { expect, type Page } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { publishWork } from "./support/works.ts";
import type { ShelfRecord } from "../packages/web-ui/src/lib/reading-shelf.ts";
import { captureReadingPosition } from "../packages/web-ui/src/lib/reading-position.ts";
import { holdAnimationFrames } from "./support/animation-frame-gate.ts";

const PREFIX = "nw-reading-list-v1:";
let chinese = "", english = "";
test.beforeAll(async ({ request }) => {
  chinese = (await publishWork(request, `清单验证 ${Date.now().toString(36)}`, ["读者自己留下一部作品，不等于向网站报告阅读历史。", "第二段正文，等待下次回来。"])).slug;
  english = (await publishWork(request, `Reading shelf ${Date.now().toString(36)}`, Array.from({ length: 48 }, (_, i) => `Section ${i + 1}. A distinct paragraph for deliberate reading and a verifiable saved location. ${"The words remain on this browser. ".repeat(8)}`), "en")).slug;
});
const records = (page: Page): Promise<ShelfRecord[]> => page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key)!) as ShelfRecord), PREFIX);
const articleEntry = (page: Page) => page.getByRole("region", { name: "Reading list", exact: true });
async function saveEnglish(page: Page) {
  await page.goto(`/en/articles/${english}`);
  await articleEntry(page).getByRole("button", { name: "Add to reading list", exact: true }).click();
  await expect(articleEntry(page).getByRole("button", { name: "In your reading list", exact: true })).toBeVisible();
}
function seed(index: number, patch: Partial<ShelfRecord> = {}): ShelfRecord {
  return { version: 1, slug: `saved-work-${String(index).padStart(3, "0")}`, locale: "en", title: `Work ${String(index).padStart(3, "0")}`, author: "Reader fixture", workType: "other", state: "later", savedAt: 2000, updatedAt: 2000, revision: `entry-${index}`, tracking: null, position: null, ...patch };
}

test("visiting never creates reading history; explicit saves survive reload and both language entries are usable", async ({ page }) => {
  await page.goto(`/articles/${chinese}`);
  const entry = page.getByRole("region", { name: "阅读清单", exact: true });
  await expect(entry.getByRole("button", { name: "加入阅读清单", exact: true })).toBeEnabled();
  expect(await records(page)).toEqual([]);
  await entry.getByRole("button", { name: "加入阅读清单", exact: true }).click();
  await expect(entry.getByRole("checkbox", { name: "在本机记住我的阅读位置", exact: true })).not.toBeChecked();
  await page.reload();
  await expect(entry.getByRole("button", { name: "已在阅读清单中", exact: true })).toBeDisabled();
  await saveEnglish(page);
  expect((await records(page)).map(row => row.locale).sort()).toEqual(["en", "zh-CN"]);
  expect((await records(page)).every(row => row.tracking === null && row.position === null)).toBe(true);
  await articleEntry(page).getByRole("link", { name: "Open reading list", exact: false }).click();
  await expect(page).toHaveURL(/\/en\/reading-list$/);
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(2);
  await page.locator(".nw-pill").getByRole("link", { name: "简", exact: true }).click();
  await expect(page).toHaveURL(/\/reading-list$/);
  await expect(page.getByRole("heading", { name: "阅读清单", exact: true })).toBeVisible();
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(2);
});

test("two tabs preserve unrelated saves and a stale remove confirmation cannot erase a newer state", async ({ page, context }) => {
  const other = await context.newPage();
  await Promise.all([page.goto(`/en/articles/${english}`), other.goto(`/articles/${chinese}`)]);
  await Promise.all([
    articleEntry(page).getByRole("button", { name: "Add to reading list", exact: true }).click(),
    other.getByRole("region", { name: "阅读清单", exact: true }).getByRole("button", { name: "加入阅读清单", exact: true }).click(),
  ]);
  await expect.poll(async () => (await records(page)).length).toBe(2);
  await page.goto("/en/reading-list");
  const row = page.locator(`li[data-shelf-id="en:${english}"]`);
  await row.getByRole("button", { name: /^Remove:/ }).click();
  const dialog = page.getByRole("dialog", { name: "Remove this work from your list?", exact: true });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await other.goto(`/en/articles/${english}`);
  await articleEntry(other).getByRole("combobox", { name: "Reading state", exact: true }).selectOption("finished");
  await expect(row.getByRole("combobox")).toHaveValue("finished");
  await dialog.getByRole("button", { name: "Remove from this browser", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Another tab or action changed this entry");
  await expect(row).toHaveCount(1);
  expect((await records(page)).find(entry => entry.slug === english)?.state).toBe("finished");
  await other.close();
});

test("local pagination, combined filters, bulk changes and real keyboard row movement retain their scope", async ({ page }) => {
  const entries = Array.from({ length: 25 }, (_, index) => seed(index));
  await page.addInitScript(({ prefix, entries }) => { for (const row of entries) localStorage.setItem(`${prefix}${row.locale}:${row.slug}`, JSON.stringify(row)); }, { prefix: PREFIX, entries });
  await page.goto("/en/reading-list");
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(20);
  await page.locator(".nw-shelf-rows input[type=checkbox]").nth(0).check();
  await page.locator(".nw-shelf-rows input[type=checkbox]").nth(1).check();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(5);
  await page.locator(".nw-shelf-rows input[type=checkbox]").first().check();
  await expect(page.getByText(/^3 editions selected/)).toBeVisible();
  await page.getByRole("button", { name: "Change selected states", exact: true }).click();
  await expect.poll(async () => (await records(page)).filter(row => row.state === "finished").length).toBe(3);
  await page.getByRole("button", { name: "Finished (3)", exact: true }).click();
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(3);
  const links = page.locator("[data-shelf-title]");
  await links.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(links.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(links.last()).toBeFocused();
  await page.getByRole("searchbox", { name: "Search this list", exact: true }).fill("Work 020");
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(1);
  await expect(page).toHaveURL(/\/en\/reading-list$/);
  await expect(page.getByText(/^0 editions selected/)).toBeVisible();
});

test("backup uses preview/keep defaults, strips imported consent, escapes labels, and exports only the local format", async ({ page }) => {
  await saveEnglish(page);
  await page.goto("/en/reading-list");
  const existing = (await records(page))[0]!;
  const incoming = [seed(90, { title: "<img src=x onerror=alert(1)>", tracking: "foreign-consent", state: "reading" }), { ...existing, title: "Do not overwrite my current title" }];
  const backup = { format: "no-wave-reading-list", version: 1, exportedAt: 3000, entries: incoming };
  await page.getByLabel("Choose JSON backup", { exact: true }).setInputFiles({ name: "shelf.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  const preview = page.getByRole("region", { name: "Import preview", exact: true });
  await expect(preview).toContainText("1 new · 0 replaced · 1 kept");
  expect((await records(page)).length).toBe(1);
  await expect(preview.locator("img")).toHaveCount(0);
  await preview.getByRole("button", { name: "Apply this preview", exact: true }).click();
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(2);
  const saved = await records(page);
  expect(saved.find(row => row.slug === english)?.title).toBe(existing.title);
  expect(saved.find(row => row.slug === "saved-work-090")?.tracking).toBeNull();
  await expect(page.getByRole("link", { name: "<img src=x onerror=alert(1)>", exact: true })).toHaveAttribute("href", "/en/articles/saved-work-090");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON backup", exact: true }).click();
  const download = await downloadEvent;
  const { readFile } = await import("node:fs/promises");
  const contents = await readFile((await download.path())!, "utf8");
  expect(contents).not.toContain("foreign-consent");
  expect(JSON.parse(contents).format).toBe("no-wave-reading-list");
  expect(JSON.parse(contents).entries).toHaveLength(2);
});

test("a changed import preview must be reviewed again, and damaged input never partially imports", async ({ page, context }) => {
  await saveEnglish(page);
  const other = await context.newPage();
  await other.goto(`/en/articles/${english}`);
  await page.goto("/en/reading-list");
  const backup = { format: "no-wave-reading-list", version: 1, exportedAt: 3000, entries: [seed(8)] };
  const file = page.getByLabel("Choose JSON backup", { exact: true });
  await file.setInputFiles({ name: "shelf.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  const preview = page.getByRole("region", { name: "Import preview", exact: true });
  await expect(preview).toBeVisible();
  await articleEntry(other).getByRole("combobox", { name: "Reading state", exact: true }).selectOption("finished");
  await expect(preview.getByRole("button", { name: "Apply this preview", exact: true })).toBeDisabled();
  await preview.getByRole("button", { name: "Import preview", exact: true }).click();
  await preview.getByRole("button", { name: "Apply this preview", exact: true }).click();
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(2);
  await file.setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...backup, entries: [seed(9), { ...seed(10), slug: "//outside.invalid" }] })) });
  await expect(page.getByRole("alert")).toContainText("A backup entry is invalid");
  expect((await records(page)).length).toBe(2);
  await other.close();
});

test("explicit clear removes corrupt list records too, but cannot erase notes or unrelated browser settings", async ({ page }) => {
  await page.addInitScript(({ prefix, entry }) => {
    localStorage.setItem(`${prefix}${entry.locale}:${entry.slug}`, JSON.stringify(entry));
    localStorage.setItem(`${prefix}en:broken`, "not-json");
    localStorage.setItem("nw-theme", "light");localStorage.setItem("nw-passages-v1:keep", "reader-owned notes");
  }, { prefix: PREFIX, entry: seed(1) });
  await page.goto("/en/reading-list");
  await expect(page.getByRole("alert")).toContainText("1 reading-list records could not be read");
  await page.getByRole("button", { name: "Clear reading list", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Clear this browser’s reading list?", exact: true });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Clear reading list", exact: true }).click();
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Saved works", exact: true })).toBeFocused();
  expect(await page.evaluate(() => [localStorage.getItem("nw-theme"), localStorage.getItem("nw-passages-v1:keep")])).toEqual(["light", "reader-owned notes"]);
  expect(await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)), PREFIX)).toEqual([]);
});

test("storage refusal stays actionable and unsupported locking is read-only rather than an unsafe fallback", async ({ page, context }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } }); });
  await page.goto(`/en/articles/${english}`);
  await expect(articleEntry(page).getByRole("alert")).toContainText("Local storage is unavailable");
  await expect(articleEntry(page).getByRole("button", { name: "Add to reading list", exact: true })).toBeDisabled();
  await expect(page.locator("#nw-article")).toBeVisible();
  const readOnly = await context.newPage();
  await readOnly.addInitScript(({ prefix, entry }) => { localStorage.setItem(`${prefix}${entry.locale}:${entry.slug}`, JSON.stringify(entry)); Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }); }, { prefix: PREFIX, entry: seed(1) });
  await readOnly.goto("/en/reading-list");
  await expect(readOnly.locator(".nw-shelf-rows > li")).toHaveCount(1);
  await expect(readOnly.getByText(/Safe cross-tab writes are unavailable/)).toBeVisible();
  await expect(readOnly.getByRole("button", { name: "Download JSON backup", exact: true })).toBeEnabled();
  await expect(readOnly.locator(".nw-shelf-rows button")).toBeDisabled();
  await readOnly.close();
});

test("position memory needs opt-in and deliberate movement; returning preserves it until an explicit verified resume", async ({ page }) => {
  await saveEnglish(page);
  const entry = articleEntry(page);
  const remember = entry.getByRole("checkbox", { name: "Remember my position on this browser", exact: true });
  await remember.click();
  await expect(remember).toBeChecked();
  await expect.poll(async () => (await records(page))[0]?.tracking).not.toBeNull();
  const paragraph = page.locator("#nw-article > [data-block]").nth(15);
  await paragraph.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  expect((await records(page))[0]?.position).toBeNull();
  await page.evaluate(() => {
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    window.scrollBy(0, 100);
  });
  await page.waitForTimeout(1200);
  expect((await records(page))[0]?.position).toBeNull();
  await page.mouse.move(500, 300);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await records(page))[0]?.position, { timeout: 10_000 }).not.toBeNull();
  const saved = (await records(page))[0]!.position!;
  await page.reload();
  await expect(entry.getByRole("button", { name: "Continue from saved position", exact: true })).toBeVisible();
  await page.waitForTimeout(1200);
  expect((await records(page))[0]!.position).toEqual(saved);
  await entry.getByRole("button", { name: "Continue from saved position", exact: true }).click();
  await expect(page.locator(`#nw-article > [data-block="${saved.blockId}"]`)).toBeFocused();
  await expect(entry).toContainText("Returned to your saved position.");
  await remember.click();
  await expect(remember).not.toBeChecked();
  await expect.poll(async () => (await records(page))[0]?.tracking).toBeNull();
  const stopped = (await records(page))[0]!.position;
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(1200);
  expect((await records(page))[0]!.position).toEqual(stopped);
});

async function fixturePosition(page: Page, blockIndex = 15) {
  const blocks = await page.locator("#nw-article > [data-block]").evaluateAll(elements => elements.map((element, index) => ({ id: (element as HTMLElement).dataset.block!, text: element.textContent ?? "", top: index * 100, height: 100 })));
  const position = captureReadingPosition(blocks, blockIndex * 100 + 50, "fixture-before-edit");
  expect(position).not.toBeNull();
  await page.evaluate(({ prefix, slug, position }) => navigator.locks.request("nw-reading-list-v1", () => {
    const key = `${prefix}en:${slug}`;
    const entry = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...entry, position, tracking: null, revision: "fixture-position" }));
  }), { prefix: PREFIX, slug: english, position });
  await page.reload();
  await expect(articleEntry(page).getByRole("button", { name: "Continue from saved position", exact: true })).toBeVisible();
  return position!;
}

test("fragment links win over saved memory, and an edited witness never causes an approximate resume", async ({ page }) => {
  await saveEnglish(page);
  const position = await fixturePosition(page);
  await page.goto(`/en/articles/${english}#nw-comments-title`);
  const entry = articleEntry(page);
  await entry.getByRole("button", { name: "Continue from saved position", exact: true }).click();
  await expect(entry).toContainText("This link already points to a heading or shared passage");
  expect((await records(page))[0]!.position).toEqual(position);
  await page.goto(`/en/articles/${english}`);
  await page.locator(`#nw-article > [data-block="${position.blockId}"]`).evaluate(element => { element.textContent = "This paragraph has been replaced, despite retaining the old block id."; });
  await entry.getByRole("button", { name: "Continue from saved position", exact: true }).click();
  await expect(entry).toContainText("The saved passage is no longer in this edition");
  await expect(entry.getByRole("button", { name: "Continue from saved position", exact: true })).toBeFocused();
  expect((await records(page))[0]!.position).toEqual(position);
});

test("a newer keyboard intent cancels a deferred resume and leaves its old progress unchanged", async ({ page }) => {
  await saveEnglish(page);
  const position = await fixturePosition(page);
  const resume = articleEntry(page).getByRole("button", { name: "Continue from saved position", exact: true });
  await resume.focus();
  const release = await holdAnimationFrames(page);
  try {
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
  } finally { await release(); }
  await expect(articleEntry(page)).toContainText("Continue was cancelled because you moved elsewhere.");
  await expect(page.locator(`#nw-article > [data-block="${position.blockId}"]`)).not.toBeFocused();
  expect((await records(page))[0]!.position).toEqual(position);
});

test("revoking consent in another tab ahead of a queued checkpoint cannot resurrect tracking or a position", async ({ page, context }) => {
  await saveEnglish(page);
  const remember = articleEntry(page).getByRole("checkbox", { name: "Remember my position on this browser", exact: true });
  await remember.click();
  await expect(remember).toBeChecked();
  const other = await context.newPage();
  await other.goto(`/en/articles/${english}`);
  const otherRemember = articleEntry(other).getByRole("checkbox", { name: "Remember my position on this browser", exact: true });
  await expect(otherRemember).toBeChecked();
  await other.evaluate(() => new Promise<void>((resolve, reject) => {
    const view = window as Window & { releaseShelfLock?: () => void; shelfLockDone?: Promise<void> };
    view.shelfLockDone = navigator.locks.request("nw-reading-list-v1", () => new Promise<void>(release => { view.releaseShelfLock = release; resolve(); })).catch(reject);
  }));
  try {
    await otherRemember.click();
    await expect(otherRemember).toBeDisabled();
    await page.locator("#nw-article > [data-block]").nth(15).scrollIntoViewIfNeeded();
    await page.mouse.move(500, 300);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name === "nw-reading-list-v1").length ?? 0), { timeout: 10_000 }).toBe(2);
  } finally {
    await other.evaluate(async () => { const view = window as Window & { releaseShelfLock?: () => void; shelfLockDone?: Promise<void> };view.releaseShelfLock?.();await view.shelfLockDone; });
  }
  await expect(otherRemember).not.toBeChecked();
  await expect(remember).not.toBeChecked();
  expect((await records(page))[0]!.tracking).toBeNull();
  expect((await records(page))[0]!.position).toBeNull();
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(1200);
  expect((await records(page))[0]!.position).toBeNull();
  await other.close();
});

test("the mobile list keeps long labels within its viewport and all mutations use native scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(({ prefix, entry }) => localStorage.setItem(`${prefix}${entry.locale}:${entry.slug}`, JSON.stringify(entry)), { prefix: PREFIX, entry: seed(1, { title: "A".repeat(180), author: "Long author ".repeat(12) }) });
  await page.goto("/en/reading-list");
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(1);
  await expect(page.locator("html")).not.toHaveClass(/nw-smooth/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const row = page.locator(".nw-shelf-rows > li").first();
  await row.getByRole("combobox").selectOption("reading");
  await expect(row.getByRole("combobox")).toHaveValue("reading");
  await row.getByRole("button", { name: /^Remove:/ }).click();
  const dialog = page.getByRole("dialog", { name: "Remove this work from your list?", exact: true });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Remove from this browser", exact: true }).click();
  await expect(page.locator(".nw-shelf-rows > li")).toHaveCount(0);
});

test("leaving through the list link flushes an already sampled position before the one-second throttle", async ({ page }) => {
  await saveEnglish(page);
  const remember = articleEntry(page).getByRole("checkbox", { name: "Remember my position on this browser", exact: true });
  await remember.click();
  await expect(remember).toBeChecked();
  await page.locator("#nw-article > [data-block]").nth(15).scrollIntoViewIfNeeded();
  await page.mouse.move(500, 300);
  await page.mouse.wheel(0, 300);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect((await records(page))[0]!.position).toBeNull();
  await articleEntry(page).getByRole("link", { name: "Open reading list", exact: false }).click();
  await expect(page.getByRole("heading", { name: "Reading list", exact: true })).toBeVisible();
  await expect.poll(async () => (await records(page))[0]?.position).not.toBeNull();
  await expect(page.locator(".nw-shelf-rows > li")).toContainText("Saved position");
});
