/**
 * The marks a reader sets in a comment.
 *
 * Why this file exists: the comment composer showed four formatting buttons —
 * bold, italic, underline, strikethrough — and a link button that worked. The
 * four that did nothing were the four the composer dispatched a command for
 * and nobody answered: a plain-text editor has no listener for the format
 * commands, so the reader's text stayed plain, silently, with the buttons
 * right there saying otherwise. The API stored marks, the reading page drew
 * them, and the only way to write one was a document the reader never had.
 *
 * The journeys here are the ones a unit test cannot make:
 *
 * - what the reader marks in the comment box arrives at the reader;
 * - the comment box answers the keyboard alone, the way the article editor
 *   does — the same parity the accessibility register asks for;
 * - the comment box stays operable when the window is short, the way it has
 *   to be on a phone whose keyboard has taken the bottom half of the screen.
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

/** The comment a reader writes in these journeys. */
const SENTENCE = "这一句会被加粗。";

/**
 * The comment the reader published, in the list under the work.
 *
 * The comment is an `<article>` of its own, so the accessibility tree finds
 * it; a mark has no role of its own — it is an element around the words — so
 * that one step looks at the element.
 */
function publishedComment(page: import("@playwright/test").Page) {
  return page.getByRole("article").filter({ hasText: SENTENCE });
}

test("the mark a reader sets in a comment reaches the reader", async ({
  page,
  request,
  readingStack,
}) => {
  const { slug } = await publishWork(
    request,
    `评论格式 ${Date.now().toString(36)}`,
    ["一篇可供评论的文章。"],
    undefined,
    readingStack.apiBaseUrl,
  );
  await registerThroughForm(page, uniqueEmail("comment-mark"));

  await page.goto(`/articles/${slug}`);
  const editor = page.getByLabel("评论内容");
  await editor.click();
  await page.keyboard.type(SENTENCE);

  // The selection the reader makes with the keyboard, the way they would
  // without a pointing device.
  await page.keyboard.down("Shift");
  await page.keyboard.press("Home");
  await page.keyboard.up("Shift");

  // The toolbar's bold button.
  await page.getByRole("button", { name: "粗体 B", exact: true }).click();
  await expect(editor.locator("strong")).toHaveText(SENTENCE);

  await page.getByRole("button", { name: "提交评论" }).click();
  await expect(page.getByText("评论已发布。", { exact: true })).toBeVisible({
    timeout: 45_000,
  });

  // The mark is not only in the box: it is in the comment the reader published,
  // drawn by the same renderer that draws an author's emphasis.
  await expect(
    publishedComment(page).locator("strong", { hasText: SENTENCE }),
  ).toHaveText(SENTENCE);
});

test("the comment editor answers the keyboard alone", async ({
  page,
  request,
  readingStack,
}) => {
  const { slug } = await publishWork(
    request,
    `评论键盘 ${Date.now().toString(36)}`,
    ["一篇可供评论的文章。"],
    undefined,
    readingStack.apiBaseUrl,
  );
  await registerThroughForm(page, uniqueEmail("comment-keyboard"));

  await page.goto(`/articles/${slug}`);
  const editor = page.getByLabel("评论内容");
  await editor.click();
  await page.keyboard.type(SENTENCE);
  await page.keyboard.down("Shift");
  await page.keyboard.press("Home");
  await page.keyboard.up("Shift");

  // The shortcut the article editor answers.
  await page.keyboard.press("Control+B");
  await expect(editor.locator("strong")).toHaveText(SENTENCE);

  // And the toolbar's own button, reached and pressed without a pointer: the
  // editor keeps the reader's selection while the button has the focus.
  // The selection is made forwards this time — the one above ran backwards
  // from the end of the line, and extending it further would have collapsed
  // it rather than widened it.
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: "斜体 I", exact: true }).focus();
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "提交评论" }).click();
  await expect(page.getByText("评论已发布。", { exact: true })).toBeVisible({
    timeout: 45_000,
  });

  // Both marks are in the published comment: the one the shortcut set and the
  // one the button set, each drawn where it was written.
  const published = publishedComment(page);
  await expect(published.locator("strong", { hasText: SENTENCE })).toHaveText(
    SENTENCE,
  );
  await expect(published.locator("em", { hasText: SENTENCE })).toHaveText(
    SENTENCE,
  );
});

test("the comment editor stays operable on a short window", async ({
  page,
  request,
  readingStack,
}) => {
  const { slug } = await publishWork(
    request,
    `评论窄窗 ${Date.now().toString(36)}`,
    ["一篇可供评论的文章。"],
    undefined,
    readingStack.apiBaseUrl,
  );
  // The window of a phone with the keyboard open. The viewport is set before
  // the navigation, so the composer is used in the height it really has while
  // the reader is typing — not in a window that was tall until the keyboard
  // appeared.
  await page.setViewportSize({ width: 390, height: 420 });
  await registerThroughForm(page, uniqueEmail("comment-short"));
  await page.goto(`/articles/${slug}`);

  const editor = page.getByLabel("评论内容");
  await editor.scrollIntoViewIfNeeded();
  await editor.click();
  await page.keyboard.type(SENTENCE);
  await page.keyboard.down("Shift");
  await page.keyboard.press("Home");
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: "粗体 B", exact: true }).click();
  // The words and the mark are still there in the short window.
  await expect(editor.locator("strong")).toHaveText(SENTENCE);

  // The submit control is on the page and nothing lies on top of it: a
  // composer the reader cannot reach is a comment they cannot write.
  const submit = page.getByRole("button", { name: "提交评论" });
  const box = await submit.boundingBox();
  expect(box, "the submit control has a place on the page").not.toBeNull();
  const covering = await page.evaluate(
    ({ x, y }) => {
      const node = document.elementFromPoint(x, y);
      if (!node) return "none";
      return node.closest("button")?.textContent?.trim() ?? "";
    },
    {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
    },
  );
  expect(covering, "the submit control is not covered").toContain("提交评论");

  await submit.click();
  await expect(page.getByText("评论已发布。", { exact: true })).toBeVisible({
    timeout: 45_000,
  });
  await expect(
    publishedComment(page).locator("strong", { hasText: SENTENCE }),
  ).toHaveText(SENTENCE);
});
