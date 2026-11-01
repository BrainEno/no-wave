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

/** Drag the pointer across part of an element, the way a reader selects text. */
export async function selectPartOf(page: Page, locator: Locator, fraction = 0.6): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("the element to select inside has no box on screen");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fraction, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}
