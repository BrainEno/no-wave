import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * A published work, made over HTTP.
 *
 * Two browser journeys need one — 朗读 needs something to say and 划线 needs
 * something to mark — and neither is about the editor, so neither should spend
 * a minute typing into it. This is the same bargain the rest of the suite
 * strikes: setup over HTTP, because it is deterministic, and the browser does
 * every interaction the assertions are actually about.
 */

const API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";
export const WORK_PASSWORD = "e2e-work-password";

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/** A Lexical document with the given paragraphs, in the shape the API accepts. */
export function editorState(paragraphs: readonly string[]) {
  return {
    root: {
      children: paragraphs.map((text) => ({
        children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
        direction: null, format: "", indent: 0, type: "paragraph", version: 1,
      })),
      direction: null, format: "", indent: 0, type: "root", version: 1,
    },
  };
}

/**
 * One account with a profile and one published work.
 *
 * The profile is not decoration: the public reader drops works whose author has
 * none, so without it the article would exist and still be unreachable.
 */
export async function publishWork(
  request: APIRequestContext,
  title: string,
  paragraphs: readonly string[],
): Promise<{ email: string; slug: string }> {
  const email = uniqueEmail("work");
  const registered = await request.post(`${API_BASE_URL}/api/v1/auth/register`, {
    data: { email, password: WORK_PASSWORD },
  });
  expect(registered.status(), `registering ${email}: ${await registered.text()}`).toBe(201);
  const { accessToken } = (await registered.json()).data as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}`, origin: API_BASE_URL };

  const profile = await request.put(`${API_BASE_URL}/api/v1/me/profile`, {
    data: { displayName: "无浪作者", bio: "浏览器验证账户。", locale: "zh-CN" },
    headers,
  });
  expect(profile.status(), `creating the author profile: ${await profile.text()}`).toBe(200);

  const created = await request.post(`${API_BASE_URL}/api/v1/articles`, {
    data: { title, editorState: editorState(paragraphs), contentBlocksVersion: 1, publish: true },
    headers,
  });
  expect(created.status(), `publishing ${title}: ${await created.text()}`).toBe(201);
  const slug = (await created.json()).data.slug as string;
  expect(slug.length).toBeGreaterThan(0);
  return { email, slug };
}

/**
 * Drag the pointer across part of an element, the way a reader selects text.
 *
 * Two things make this deterministic on a cold CI runner. The element is
 * scrolled into view and the webfonts are awaited before its box is measured —
 * a Chinese webfont swapping in moves the paragraph after `boundingBox()`, so
 * dragging at the old coordinates can leave no selection at all. Then the
 * selection itself is checked rather than assumed: if the drag produced
 * nothing, the box is measured again and the drag is repeated once, and a
 * genuinely broken drag fails immediately with a useful message instead of
 * waiting a minute for a toolbar that can never appear.
 */
export async function selectPartOf(page: Page, locator: Locator, fraction = 0.6): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    // A stalled font CDN must not hold the journey: swap fonts settle quickly
    // when reachable, and the fallback metrics are otherwise good enough. The
    // second attempt below re-measures the box if a late swap still moved it.
    await Promise.race([
      document.fonts.ready,
      new Promise<void>((resolve) => { setTimeout(resolve, 5_000); }),
    ]);
    return true;
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const box = await locator.boundingBox();
    if (!box) throw new Error("the element to select inside has no box on screen");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 8, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * fraction, y, { steps: 8 });
    await page.mouse.up();
    const selected = await locator.evaluate((element) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
      const range = selection.getRangeAt(0);
      // A selection that crosses into the next paragraph has the article as its
      // common ancestor, but it still overlaps this one — intersectsNode is
      // the honest test for "the drag selected something here".
      return range.intersectsNode(element) ? selection.toString().trim() : "";
    });
    if (selected.length > 0) return;
  }
  throw new Error("dragging across the paragraph did not leave a text selection in it");
}
