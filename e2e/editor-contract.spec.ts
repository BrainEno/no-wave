/**
 * The editor's contract with the reader, end to end in a real browser.
 *
 * Why this file exists: the API stored a document's inline formatting and its
 * links correctly, and every API test was green, while the reading page drew
 * the plain-text fallback and dropped every mark and every link. A published
 * work silently lost its emphasis and its hyperlinks, and nothing below the
 * browser could see it — the defect lived between the stored document and the
 * rendered one.
 *
 * The journeys here are the ones a unit test cannot make:
 *
 * - what the author writes with the toolbar has to arrive at the reader as the
 *   marks and the links they wrote;
 * - a document has to survive save → reload → a second edit → a second save,
 *   with its structure intact;
 * - a reader's page may only draw links to HTTP(S) addresses;
 * - the formatting controls have to be nameable and reachable without a mouse;
 * - the desk has to be usable on a phone-sized screen;
 * - and it has to stay usable when the screen is short: the caret the author
 *   is typing at may not end up underneath the desk's floating action dock,
 *   where the author cannot see it.
 *
 * What is deliberately *not* here: the API's own refusal of a `javascript:` or
 * protocol-relative address. That is the article contract's rule, it is already
 * proved at the cheapest layer (`apps/api/src/domain/article.test.ts`), and
 * repeating it here would only spend the API's write budget — the browser
 * suite's per-shard budget of thirty article creations an hour is finite, and
 * every extra one is a creation the rest of the shard cannot make.
 *
 * Rules of the layer (see docs/testing/end-to-end.md):
 * - selectors follow the accessibility tree, never CSS;
 * - every test creates its own account;
 * - account setup goes through HTTP; the browser does the interactions the
 *   assertions are about;
 * - assertions wait on durable outcomes, not on transient state.
 *
 * Every test runs against a disposable stack of its own (see
 * `support/editor-stack.ts`): this file publishes one work per test, and the
 * browser suite's article-creation budget is thirty per IP per hour — shared,
 * it would run out in the middle of the file.
 */
import { expect, type APIRequestContext } from "@playwright/test";
import { test } from "./support/editor-stack.ts";
import type { FontStack } from "./support/font-stack.ts";
import {
  PASSWORD,
  registerDeskTraffic,
  registerWriter,
  savedSlug,
  uniqueEmail,
  waitForEditor,
  type AuthoringDeskTarget,
} from "./support/authoring-desk.ts";

registerDeskTraffic();

type InlineRun = { text: string; marks?: string[]; href?: string };
type ContentBlock = {
  id: string;
  type: string;
  text?: string;
  inlines?: InlineRun[];
  items?: string[];
  itemInlines?: InlineRun[][];
  ordered?: boolean;
};

/**
 * Where the test writes: its own stack's API, and the origin its browser
 * mutations declare. The login proxy refuses a mutation whose `Origin` is not
 * exactly its own, so the header follows the stack rather than a constant.
 */
function deskTarget(editorStack: FontStack): AuthoringDeskTarget {
  return {
    apiBaseUrl: editorStack.apiBaseUrl,
    origin: new URL(editorStack.webBaseUrl).origin,
  };
}

/** Register an author and publish a work with the given document. */
async function publishDocument(
  request: APIRequestContext,
  apiBaseUrl: string,
  title: string,
  contentBlocks: ContentBlock[],
): Promise<string> {
  const email = uniqueEmail("inline");
  const registered = await request.post(`${apiBaseUrl}/api/v1/auth/register`, {
    data: { email, password: PASSWORD },
  });
  expect(registered.status(), `registering ${email}`).toBe(201);
  const { data } = (await registered.json()) as {
    data: { accessToken: string };
  };
  const authorization = { authorization: `Bearer ${data.accessToken}` };

  const profile = await request.put(`${apiBaseUrl}/api/v1/me/profile`, {
    data: { displayName: "内联作者", bio: "验证内联格式。", locale: "zh-CN" },
    headers: authorization,
  });
  expect(profile.status(), "creating the author profile").toBe(200);

  const created = await request.post(`${apiBaseUrl}/api/v1/articles`, {
    data: {
      title,
      summary: "验证内联格式是否到达读者。",
      locale: "zh-CN",
      workType: "novel",
      publish: true,
      contentBlocksVersion: 1,
      contentBlocks,
    },
    headers: authorization,
  });
  expect(created.status(), `publishing the work: ${await created.text()}`).toBe(
    201,
  );
  const { data: work } = (await created.json()) as { data: { slug: string } };
  return work.slug;
}

test("the reader page draws the emphasis and the links the author wrote", async ({
  page,
  request,
  editorStack,
}) => {
  await registerWriter(page, request, deskTarget(editorStack));
  await waitForEditor(page);

  const title = `内联到达读者 ${Date.now().toString(36)}`;
  await page.getByRole("textbox", { name: "标题", exact: true }).fill(title);

  const body = page.getByLabel("作品正文");
  await body.click();
  await page.keyboard.type("这一句会被加粗。");

  // The emphasis the author applied with the editor's own keyboard path: only
  // the first sentence, so the assertion can name exactly what was marked.
  await page.keyboard.down("Shift");
  await page.keyboard.press("Home");
  await page.keyboard.up("Shift");
  await page.keyboard.press("Control+B");
  await expect(body.locator("strong")).toHaveText("这一句会被加粗。");

  // The format stays on for what comes next, so it is turned off again before
  // the second sentence is written.
  await page.keyboard.press("End");
  await page.keyboard.press("Control+B");
  await page.keyboard.press("Enter");
  await page.keyboard.type("这一句会带上链接。");
  await expect(body.locator("strong")).toHaveCount(1);

  // The link the author applied with the editor's own toolbar.
  await page.keyboard.down("Shift");
  await page.keyboard.press("Home");
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: "链接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "插入链接" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("链接地址").fill("https://example.test/target");
  await dialog.getByRole("button", { name: "插入", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await page.getByRole("button", { name: "发布作品", exact: true }).click();
  const slug = await savedSlug(page, title, "published");

  // The reader, not the author, is the one who has to see it.
  await page.goto(`/articles/${slug}`);
  const article = page.locator('article[data-form="prose"]');
  await expect(article).toBeVisible({ timeout: 45_000 });
  await expect(article.locator("strong")).toContainText("这一句会被加粗。");
  const link = article.getByRole("link", { name: "这一句会带上链接。" });
  await expect(link).toHaveAttribute("href", "https://example.test/target");
  // A link to somewhere else is a link the reader can leave with: it has to
  // say so, and it must not pass the referring address along.
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /ugc/);
  await expect(link).toHaveAttribute("rel", /nofollow/);
  await expect(link).toHaveAttribute("rel", /noreferrer/);
});

test("a document survives save, reload, a second edit and a second save", async ({
  page,
  request,
  editorStack,
}) => {
  await registerWriter(page, request, deskTarget(editorStack));
  await waitForEditor(page);

  const title = `往返契约 ${Date.now().toString(36)}`;
  await page.getByRole("textbox", { name: "标题", exact: true }).fill(title);
  const body = page.getByLabel("作品正文");
  await body.click();
  await page.keyboard.type("第一段用来验证保存链路。");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第二段保持结构不变。");
  await expect(body).toContainText("第一段用来验证保存链路。");

  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  // The save is done when the desk says so: that message is written after the
  // API's answer, not when the request left.
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible({ timeout: 45_000 });
  await savedSlug(page, title, "draft");

  // Reload: the document has to come back from the server, not from a cache
  // the page happened to keep.
  await page.reload();
  await waitForEditor(page);
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(body).toContainText("第一段用来验证保存链路。", {
    timeout: 45_000,
  });
  await expect(body).toContainText("第二段保持结构不变。");

  // A second edit that adds a sentence to the second paragraph.
  await body.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("补一句。");
  await expect(body).toContainText("补一句。");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible({ timeout: 45_000 });

  // The second save has to have replaced the first document rather than
  // created a second work beside it.
  const works = await (async () => {
    const response = await page.request.get("/api/authoring/articles");
    expect(response.status(), "reading the author's article list").toBe(200);
    const body = (await response.json()) as {
      data: { id: string; title: string }[];
    };
    return body.data;
  })();
  expect(
    works.filter((work) => work.title === title),
    `one work, not two: ${JSON.stringify(works.map((work) => work.title))}`,
  ).toHaveLength(1);

  // And the reopened document is the edited one: both paragraphs, the addition,
  // and the structure the author wrote.
  await page.reload();
  await waitForEditor(page);
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(body).toContainText("第一段用来验证保存链路。", {
    timeout: 45_000,
  });
  await expect(body).toContainText("第二段保持结构不变。补一句。");
  await expect(body.locator("p")).toHaveCount(2);
});

test("the reading page draws only safe links, and the comment editor names its controls", async ({
  page,
  request,
  editorStack,
}) => {
  const slug = await publishDocument(
    request,
    editorStack.apiBaseUrl,
    "链接协议验证",
    [
      {
        id: "p1",
        type: "paragraph",
        text: "站内链接外链",
        inlines: [
          { text: "站内链接", href: "/articles" },
          { text: "外链", href: "https://example.test/outside" },
        ],
      },
      {
        id: "l1",
        type: "list",
        ordered: false,
        items: ["条目一", "条目二"],
        itemInlines: [
          [{ text: "条目一", marks: ["italic"] }],
          [{ text: "条目二" }],
        ],
      },
    ],
  );

  await page.goto(`/articles/${slug}`);
  const article = page.locator('article[data-form="prose"]');
  await expect(article).toBeVisible({ timeout: 45_000 });

  // Every anchor the article body draws points at an HTTP(S) address or a
  // site-absolute path. A stored document is data, not markup: a scheme that
  // reached the database by any other route cannot become an active link.
  const anchors = await article.locator("a").evaluateAll((nodes) =>
    nodes.map((node) => ({
      href: node.getAttribute("href") ?? "",
      scheme:
        /^([a-z][a-z0-9+.-]*):/i
          .exec(node.getAttribute("href") ?? "")?.[1]
          ?.toLowerCase() ?? null,
    })),
  );
  expect(
    anchors.length,
    "the article draws the links it was given",
  ).toBeGreaterThan(0);
  for (const { href, scheme } of anchors) {
    if (scheme === null) {
      expect(href.startsWith("/"), `${href} must be a site-absolute path`).toBe(
        true,
      );
      expect(
        href.startsWith("//"),
        `${href} must not be protocol-relative`,
      ).toBe(false);
      continue;
    }
    expect(
      scheme === "http" || scheme === "https",
      `${href} uses the scheme ${scheme}`,
    ).toBe(true);
  }

  // The two links the author wrote are there.
  const hrefs = anchors.map((anchor) => anchor.href);
  expect(hrefs).toContain("/articles");
  expect(hrefs).toContain("https://example.test/outside");

  // The list the author wrote keeps its emphasis.
  await expect(article.locator("em")).toHaveText("条目一");

  // The comment editor on the same page names its formatting controls: a
  // screen reader has to hear what the button does, not the letter on it.
  const toolbar = page.getByRole("toolbar", { name: "评论格式" });
  await expect(toolbar).toBeVisible({ timeout: 45_000 });
  for (const [name, visible] of [
    ["粗体 B", "B"],
    ["斜体 I", "I"],
    ["下划线 U", "U"],
    ["删除线 S", "S"],
  ] as const) {
    const control = toolbar.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toHaveAccessibleName(name);
    await expect(control).toHaveText(visible);
  }
});

test("the formatting controls are named for a screen reader and answer the keyboard", async ({
  page,
  request,
  editorStack,
}) => {
  await registerWriter(page, request, deskTarget(editorStack));
  await waitForEditor(page);

  const toolbar = page.getByRole("toolbar", { name: "富文本格式" });
  await expect(toolbar).toBeVisible();

  // Every formatting control carries a name that says what it does and names
  // the glyph that is visible on it, so a reader who says "H2" or "B" out loud
  // reaches the button (WCAG 2.5.3).
  for (const [name, visible] of [
    ["二级标题 H2", "H2"],
    ["三级标题 H3", "H3"],
    ["四级标题 H4", "H4"],
    ["粗体 B", "B"],
    ["斜体 I", "I"],
    ["下划线 U", "U"],
    ["删除线 S", "S"],
  ] as const) {
    const control = toolbar.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toHaveAccessibleName(name);
    await expect(control).toHaveText(visible);
  }

  // The keyboard reaches the same control and answers it: a focused button
  // that only reacts to a pointer is not reachable at all.
  const body = page.getByLabel("作品正文");
  await body.click();
  await page.keyboard.type("标题行");
  const heading = toolbar.getByRole("button", {
    name: "二级标题 H2",
    exact: true,
  });
  await heading.focus();
  await expect(heading).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(body.locator("h2")).toHaveText("标题行");

  // The mark buttons answer the keyboard the same way, and the mark lands on
  // the words the writer selected. The selection is made forwards, from the
  // start of the line: a selection that already reaches the end of the line
  // cannot be widened, and would collapse instead.
  await body.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("这一行要被加粗。");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  const bold = toolbar.getByRole("button", { name: "粗体 B", exact: true });
  await bold.focus();
  await expect(bold).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(body.locator("strong")).toHaveText("这一行要被加粗。");
  // The words are still there, and the heading above them is untouched.
  await expect(body).toContainText("这一行要被加粗。");
  await expect(body.locator("h2")).toHaveText("标题行");
});

test("the author can write and save on a phone-sized screen", async ({
  page,
  request,
  editorStack,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerWriter(page, request, deskTarget(editorStack));
  await waitForEditor(page);

  const title = `手机写作 ${Date.now().toString(36)}`;
  await page.getByRole("textbox", { name: "标题", exact: true }).fill(title);
  const body = page.getByLabel("作品正文");
  await body.click();
  await page.keyboard.type("在手机上写的一段话。");
  await expect(body).toContainText("在手机上写的一段话。");

  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible({ timeout: 45_000 });
  await savedSlug(page, title, "draft");

  // The desk does not scroll sideways on a phone: a horizontal scrollbar on a
  // writing screen is the reader's own line pushed out of view.
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll, "the writing desk fits a 390 pixel screen").toBe(
    dimensions.client,
  );
});

test("the editor keeps the caret clear of the action dock on a short window", async ({
  page,
  request,
  editorStack,
}) => {
  // A phone with the keyboard open: the window is a few hundred pixels tall,
  // and the desk's action dock floats over the bottom of it. The viewport is
  // set before the desk opens, so the editor is measured in the height it
  // really has while the author is typing.
  await page.setViewportSize({ width: 390, height: 420 });
  await registerWriter(page, request, deskTarget(editorStack));
  await waitForEditor(page);

  const title = `窄窗写作 ${Date.now().toString(36)}`;
  await page.getByRole("textbox", { name: "标题", exact: true }).fill(title);
  const body = page.getByLabel("作品正文");
  await body.click();
  for (let line = 1; line <= 6; line += 1) {
    await page.keyboard.type(`第${line}行。`);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type("最后一行。");
  await expect(body).toContainText("最后一行。");

  // The caret has to be visible. The dock floats over the bottom of the
  // window, and a caret underneath it is a caret the author cannot see: the
  // words are there, but the author cannot tell where they are writing.
  const caret = await page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const covering = document.elementFromPoint(rect.left + 1, rect.top + 1);
    return {
      bottom: rect.bottom,
      covering: covering
        ? `${covering.tagName}.${covering.getAttribute("class") ?? ""}`
        : "none",
      inEditor: Boolean(covering?.closest('[aria-label="作品正文"]')),
    };
  });
  expect(caret, "the editor keeps a caret").not.toBeNull();
  expect(caret!.inEditor, `the caret is covered by ${caret!.covering}`).toBe(
    true,
  );
  const viewport = page.viewportSize();
  expect(caret!.bottom, "the caret is inside the window").toBeLessThanOrEqual(
    viewport!.height,
  );

  // The words and the mark survive the short window: the toolbar is still
  // there, still answers, and still marks what the author selected.
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: "粗体 B", exact: true }).click();
  await expect(body.locator("strong")).toHaveText("最后一行。");

  // And the dock's own action still publishes the work: a window too short
  // for the dock would be a window where the author cannot save.
  const publish = page.getByRole("button", { name: "发布作品", exact: true });
  await expect(publish).toBeVisible();
  await expect(publish).toBeEnabled();
  await publish.click();
  await savedSlug(page, title, "published");
});
