import { expect, test, type Page } from "@playwright/test";
import { publishWork } from "./support/works.ts";

/**
 * 朗读 — the reading-aloud control, end to end in a real browser.
 *
 * Why the engine is faked: none of the cheaper layers can see this component at
 * all. It renders nothing until an effect has asked whether the browser can
 * speak, so the server-rendered page does not contain it, and what it does next
 * — hand one chunk to the engine at a time, mark the paragraph being spoken,
 * stop when asked — happens entirely in the browser. A headless browser has no
 * voices installed, so the real engine cannot be driven; the engine here is
 * replaced with one that reports what it was given and when.
 *
 * What that does and does not prove: it proves the page's half — the order the
 * paragraphs are handed over, the mark that follows them, stopping, and the
 * absence of the control when the capability is missing (ADR 0020). It says
 * nothing about how any particular voice sounds. Which chunks exist at all is
 * decided in `lib/read-aloud.ts` and covered there, without a browser.
 *
 * One work is published for the whole file, in `beforeAll`: reading aloud
 * persists nothing (ADR 0020), so the three journeys share a page they cannot
 * change, and the suite spends one account on it instead of three.
 */

const FIRST_PARAGRAPH = "第一段用来朗读，句子不长，足够看出顺序。";
const SECOND_PARAGRAPH = "第二段接在后面，它证明标记跟着段落走。";
const TITLE_PREFIX = "朗读验证";

let slug = "";
let title = "";

test.beforeAll(async ({ request }) => {
  title = `${TITLE_PREFIX} ${Date.now().toString(36)}`;
  const work = await publishWork(request, title, [FIRST_PARAGRAPH, SECOND_PARAGRAPH]);
  slug = work.slug;
});

/**
 * Replace the browser's speech engine with one that answers immediately.
 *
 * Installed before the page's own scripts, so the component finds it in the
 * effect where it asks whether the browser can speak at all.
 *
 * `endAfterMs` is how long each chunk is "spoken". It is long enough for the
 * states between chunks to be observable: the point of the assertions is the
 * order of things, and a state that ends before the next poll cannot be seen.
 */
async function installEngine(page: Page, endAfterMs = 1_200): Promise<void> {
  await page.addInitScript((delay) => {
    const spoken: string[] = [];
    const state = { spoken, cancelled: 0, paused: false };
    (window as unknown as { __engine: typeof state }).__engine = state;
    class FakeUtterance {
      text: string;
      lang = "";
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) { this.text = text; }
    }
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak(utterance: FakeUtterance): void {
          spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), delay);
        },
        cancel(): void { state.cancelled += 1; },
        pause(): void { state.paused = true; },
        resume(): void { state.paused = false; },
      },
    });
  }, endAfterMs);
}

/** Take the engine away, the way a browser that cannot speak would. */
async function removeEngine(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: undefined });
  });
}

const spokenTexts = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __engine: { spoken: string[] } }).__engine.spoken);

test("the control reads the work paragraph by paragraph and marks the one being spoken", async ({ page }) => {
  await installEngine(page);
  await page.goto(`/articles/${slug}`);

  const aloud = page.locator("[data-read-aloud]");
  await expect(aloud.getByRole("button", { name: "朗读" }), "the control appears once the browser is known to speak")
    .toBeVisible({ timeout: 60_000 });

  await aloud.getByRole("button", { name: "朗读" }).click();

  // The first paragraph is marked while it is being spoken, and the reader is
  // told where they are — in paragraphs, which is what they can see.
  await expect(aloud.getByRole("status")).toContainText("正在朗读第 1 段，共 2 段", { timeout: 60_000 });
  await expect(page.locator("#nw-article [data-block].nw-speaking")).toHaveCount(1);
  await expect(page.locator("#nw-article [data-block].nw-speaking")).toContainText(FIRST_PARAGRAPH.slice(0, 8));

  // Then the second, and nothing is marked any more once it is over.
  await expect(aloud.getByRole("status")).toContainText("正在朗读第 2 段，共 2 段", { timeout: 60_000 });
  await expect(page.locator("#nw-article [data-block].nw-speaking")).toContainText(SECOND_PARAGRAPH.slice(0, 8), { timeout: 60_000 });
  await expect(aloud.getByRole("status")).toContainText("朗读结束", { timeout: 60_000 });
  await expect(page.locator("#nw-article [data-block].nw-speaking")).toHaveCount(0);

  // Both paragraphs, in the order they are printed, and nothing else.
  expect(await spokenTexts(page)).toEqual([FIRST_PARAGRAPH, SECOND_PARAGRAPH]);
  await expect(aloud.getByRole("button", { name: "朗读" })).toBeVisible();
});

test("stopping ends the reading, takes the mark off the page and leaves the engine quiet", async ({ page }) => {
  await installEngine(page, 5_000);
  await page.goto(`/articles/${slug}`);

  const aloud = page.locator("[data-read-aloud]");
  await expect(aloud.getByRole("button", { name: "朗读" })).toBeVisible({ timeout: 60_000 });
  await aloud.getByRole("button", { name: "朗读" }).click();
  await expect(page.locator("#nw-article [data-block].nw-speaking")).toHaveCount(1, { timeout: 60_000 });

  await aloud.getByRole("button", { name: "停止" }).click();

  await expect(page.locator("#nw-article [data-block].nw-speaking")).toHaveCount(0);
  await expect(aloud.getByRole("button", { name: "朗读" }), "the control is back at rest, not stuck on 暂停").toBeVisible();
  const cancelled = await page.evaluate(() => (window as unknown as { __engine: { cancelled: number } }).__engine.cancelled);
  expect(cancelled, "the engine was told to stop, not merely ignored").toBeGreaterThan(0);
  // The second paragraph never reaches the engine: stopping is immediate.
  expect(await spokenTexts(page)).toEqual([FIRST_PARAGRAPH]);
});

test("a browser that cannot speak is given no control at all", async ({ page }) => {
  await removeEngine(page);
  await page.goto(`/articles/${slug}`);

  // Present, not disabled: a button that can never work is a promise the page
  // cannot keep (ADR 0020).
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-read-aloud]")).toHaveCount(0);
  await expect(page.locator("[data-read-aloud]").getByRole("button")).toHaveCount(0);
});
