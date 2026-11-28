/**
 * The comment the reader typed before the page woke up.
 *
 * Why this file exists: the comment section is server-rendered, so for a moment
 * the reader is looking at a box no editor has claimed — and the server
 * rendered it as an editable box, so the browser let the reader type into it.
 * React hydrates an element by comparing the DOM with the markup it rendered,
 * found the reader's text where it expected nothing, and threw the whole page
 * away to rebuild it: the comment vanished on the way, and the page reported a
 * hydration error while it did it.
 *
 * The journey here is the one a unit test cannot make: the page is held at the
 * state the server sent it, the reader types into the box the server sent, the
 * page is allowed to wake up, and the comment has to be there — still in the
 * box, and still sendable.
 *
 * Rules of the layer (see docs/testing/end-to-end.md):
 * - selectors follow the accessibility tree, never CSS;
 * - every test creates its own account;
 * - assertions wait on durable outcomes, not on transient state.
 */
import { expect } from "@playwright/test";
import { test } from "./support/article-view-stack.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { publishWork } from "./support/works.ts";

test("a comment typed before the page hydrates survives it, and can still be sent", async ({
  page,
  request,
  readingStack,
}) => {
  const { slug } = await publishWork(
    request,
    `水合前留言 ${Date.now().toString(36)}`,
    ["一篇可供评论的文章。"],
    undefined,
    readingStack.apiBaseUrl,
  );
  await registerThroughForm(page, uniqueEmail("hydrate"));

  // The page's own errors and the console are the witnesses: React's
  // hydration error reaches the reader as an uncaught error.
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  // Hold the application bundle back, so the page stays as the server sent it
  // while the reader types into the comment box.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/*.js", async (route) => {
    await held;
    await route.continue();
  });

  await page.goto(`/articles/${slug}`, { waitUntil: "commit" });
  const editor = page.getByLabel("评论内容");
  await expect(editor).toBeVisible();
  // The box the server sent is editable — that is what lets the reader type
  // into it at all — and it holds what they typed.
  await editor.fill("水合前写下的字");
  await expect(editor).toHaveText("水合前写下的字");

  release();

  // The page wakes up. The empty comment list is the first thing only the
  // running page can say: the server sent "正在载入评论……".
  await expect(page.getByText("还没有评论，欢迎留下第一条回应。")).toBeVisible({
    timeout: 45_000,
  });

  // The page woke up without throwing the page away on the way. This is the
  // root cause of the lost comment, so it is checked first: its message says
  // what went wrong, where the empty box only says what it cost.
  expect(
    pageErrors,
    `the page must not throw while it wakes up:\n${pageErrors.join("\n")}`,
  ).toEqual([]);
  expect(
    consoleErrors.filter((text) =>
      /hydrat|Minified React error|react\.dev\/errors/i.test(text),
    ),
    `no hydration error should reach the console:\n${consoleErrors.join("\n")}`,
  ).toEqual([]);

  // The reader's comment is still in the box.
  await expect(editor).toHaveText("水合前写下的字");

  // The comment is the editor's document, not only something the reader can
  // see: it can be sent.
  await page.getByRole("button", { name: "提交评论" }).click();
  await expect(page.getByText("评论已发布。", { exact: true })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByText("水合前写下的字", { exact: true })).toBeVisible();
});
