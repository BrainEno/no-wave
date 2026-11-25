/**
 * Authoring journey, end to end in a real browser — twice.
 *
 * Why this exists: the save button was broken for most real documents while
 * every cheaper layer was green — the unit tests, the API contract tests, the
 * types. The failure lived between the Lexical editor, the REST body and the
 * adapter, and only a browser that types into the editor and clicks 保存草稿
 * can see it. These are the assertions that would have caught it, and the ones
 * that caught the follow-up bug below.
 *
 * The file runs once per framework (see playwright.config.ts): the App Router
 * and the React Router prototype, both against the **same** API and the same
 * database. That is the claim the migration needs — "an author can sign up,
 * write and publish here" — and running one spec against both is the only way to
 * make it a measurement instead of two separate assertions nobody compared. So
 * nothing in this file may hard-code which framework it is talking to: the
 * origin comes from the project's `baseURL`, and every route below is one both
 * frameworks serve.
 *
 * Rules of the layer (see docs/testing/end-to-end.md):
 * - selectors follow the accessibility tree, never CSS;
 * - every test creates its own account, so nothing depends on another test;
 * - account setup goes through HTTP (deterministic), the browser does every
 *   interaction the assertions are actually about;
 * - assertions wait on durable outcomes (the article list, the public page,
 *   the sidebar), so a flaky transient state cannot turn them green or red.
 */
import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import {
  PASSWORD,
  API_BASE_URL,
  uniqueEmail,
  pageDigest,
  signIn,
  registerWriter,
  waitForEditor,
  savedArticles,
  FIRST_PARAGRAPH,
  writeAndSave,
  savedSlug,
  answerDeskDialog,
  desk,
  registerDeskTraffic,
} from "./support/authoring-desk.ts";

registerDeskTraffic();

test("the sign-in form registers an account and opens the authoring desk", async ({
  page,
}) => {
  const email = uniqueEmail("signup");
  await page.goto("/sign-in?next=%2Fwrite");

  // A click that lands before React hydrates is silently dropped, so the mode
  // switch is retried until its effect shows up.
  try {
    await expect(async () => {
      await page
        .getByRole("button", { name: /没有账户？创建账户|已有账户？登录/ })
        .click();
      await expect(
        page.getByRole("button", { name: "创建账户并继续" }),
      ).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
  } catch (caught) {
    throw new Error(
      `the sign-in form never switched to register mode; page:\n${await pageDigest(page)}\n${String(caught)}`,
    );
  }

  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "创建账户并继续" }).click();
  await page.waitForURL("**/write", { timeout: 45_000 });
  await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible({
    timeout: 45_000,
  });
});

test("registration creates a default pen name and the writing desk can change it", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("penname");
  const registered = await request.post(
    `${API_BASE_URL}/api/v1/auth/register`,
    {
      data: { email, password: PASSWORD },
    },
  );
  expect(
    registered.status(),
    `registering ${email}: ${await registered.text()}`,
  ).toBe(201);
  const { accessToken } = (await registered.json()).data as {
    accessToken: string;
  };

  // No profile PUT: the default byline is part of the registration transaction.
  const profile = await request.get(
    `${API_BASE_URL}/api/v1/me/profile?locale=zh-CN`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  expect(
    profile.status(),
    `reading the default profile: ${await profile.text()}`,
  ).toBe(200);
  expect((await profile.json()).data.displayName).toBe("无浪作者");

  await signIn(page, email);
  await page.goto("/write");
  await expect(page.locator("[data-author-profile]")).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.locator("[data-author-profile-name]")).toHaveText(
    "无浪作者",
    { timeout: 45_000 },
  );

  await page.getByLabel("笔名").fill("新笔名");
  await page.getByRole("button", { name: "保存笔名" }).click();
  await expect(page.locator("[data-author-profile-name]")).toHaveText(
    "新笔名",
    { timeout: 45_000 },
  );
});

test("saving a draft creates the article with a generated address, and it survives a reload", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  const title = `浏览器验证草稿 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, false);
  expect(slug.length).toBeGreaterThan(0);

  // The success line, with the generated address, has to stay on screen: it is
  // the only place that tells the author where the work lives. It used to be
  // discarded by the remount that followed the save.
  const status = page.getByRole("status").filter({ hasText: "作品地址：" });
  await expect(status).toContainText("草稿已保存。", { timeout: 45_000 });
  await expect(status).toContainText(`作品地址：/articles/${slug}`);

  // Saving again updates that article instead of creating a second one, and it
  // is published from the same document without retyping anything.
  const publishButton = page.getByRole("button", { name: "发布作品" });
  await expect(publishButton).toBeVisible();
  const requestsBefore = desk.traffic.length;
  await publishButton.click();
  // A button takes focus when it is really clicked; if the click landed
  // somewhere else, this says where it went instead.
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    return active
      ? `${active.tagName}.${active.className} ${(active.textContent ?? "").slice(0, 40)}`
      : "none";
  });
  try {
    await expect(status).toContainText("作品已发布。", { timeout: 45_000 });
  } catch (caught) {
    // The client refuses a save before it sends anything, so what the page
    // says now is the only way to tell a refused save from a failed request.
    const alerts = await page.locator("[role=alert]").allTextContents();
    const editorText = (
      (await page.getByLabel("作品正文").textContent()) ?? ""
    ).slice(0, 120);
    const titleValue = await page.getByLabel("标题").inputValue();
    throw new Error(
      `publishing the saved draft did not report success; focused=${JSON.stringify(focused)} requests=${requestsBefore}->${desk.traffic.length} alerts=${JSON.stringify(alerts)}\ntraffic:\n${desk.traffic.join("\n")}\nconsole:\n${desk.consoleLog.join("\n")}\n${String(caught)}`,
    );
  }
  await expect(async () => {
    const saved = await savedArticles(page);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe("published");
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });

  // The sidebar is the durable UI signal; a reload re-reads it from the API.
  await page.reload();
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await expect(entry).toContainText("已发布");
});

test("publishing an article makes it readable at its generated address with a generated summary", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  const title = `浏览器验证发布 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  await page.goto(`/articles/${slug}`);
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible({ timeout: 45_000 });
  // Exact: the summary is rendered as a standfirst paragraph that starts with
  // the same sentence, so a substring match would be ambiguous.
  await expect(page.getByText(FIRST_PARAGRAPH, { exact: true })).toBeVisible();

  // The summary was left blank in the editor, so the API derived it from the
  // body: the page description must be the beginning of the prose, not empty.
  const description =
    (await page.locator('meta[name="description"]').getAttribute("content")) ??
    "";
  expect(
    description,
    `generated summary for /articles/${slug}; page:\n${await pageDigest(page)}`,
  ).not.toHaveLength(0);
  expect(description.startsWith("无浪是一只没有波浪的文学站点")).toBe(true);
  expect(description.length).toBeLessThanOrEqual(111);
});

test("returning a published work to draft withdraws it from the public site", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  const title = `浏览器验证撤稿 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  const publicHeading = page.getByRole("heading", { level: 1, name: title });
  await page.goto(`/articles/${slug}`);
  await expect(publicHeading).toBeVisible({ timeout: 45_000 });

  // The desk opens on a new document, so the published work has to be opened
  // from the list before it can be withdrawn — the 撤销发布 action only exists
  // for a work that is currently public.
  await page.goto("/write");
  await waitForEditor(page);
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await entry.click();
  await waitForEditor(page);
  const withdraw = page.getByRole("button", { name: "撤销发布", exact: true });
  await expect(withdraw).toBeVisible({ timeout: 45_000 });
  await withdraw.click();
  // The desk asks before it withdraws a page that readers may be on. That
  // confirmation is the product's own dialog (#F-12), not a browser `confirm()`:
  // the suite answers it, so a dialog that never appears is a failure rather
  // than a no-op, and what the author is told is an assertion of its own.
  const withdrawDialog = page.getByRole("dialog", { name: "撤销发布？" });
  await expect(withdrawDialog).toContainText("读者不能再访问");
  await expect(withdrawDialog).toContainText("内容会保留在写作台");
  await withdrawDialog.getByRole("button", { name: "确认撤销发布" }).click();

  await expect(async () => {
    const saved = await savedArticles(page);
    expect(
      saved.find((article) => article.title === title)?.status,
      JSON.stringify(saved),
    ).toBe("draft");
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });

  // The durable outcome readers can see: the address stops serving the work,
  // while the draft itself is untouched and still listed in the desk.
  await page.goto(`/articles/${slug}`);
  await expect(
    publicHeading,
    `the withdrawn work must not be readable at /articles/${slug}`,
  ).toHaveCount(0);
  await page.goto("/write");
  await expect(
    page.getByRole("button", { name: new RegExp(title) }),
  ).toContainText("草稿", { timeout: 45_000 });
});

test("deleting a work takes it out of the desk and off the site", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  const title = `浏览器验证删除 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  const publicHeading = page.getByRole("heading", { level: 1, name: title });
  await page.goto(`/articles/${slug}`);
  await expect(publicHeading).toBeVisible({ timeout: 45_000 });

  await page.goto("/write");
  await waitForEditor(page);
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await entry.click();
  await waitForEditor(page);
  await page.getByRole("button", { name: "删除作品", exact: true }).click();

  // What the confirmation says is part of the feature. It used to promise
  // \u201c删除后无法恢复\u201d; with a recycle bin behind the button that was the desk
  // lying about its own undo. It now names the way back and the one thing a
  // restore cannot give back to a third party — the comments under the work.
  const deleteDialog = page.getByRole("dialog", { name: /删除《.*》？/ });
  await expect(deleteDialog).toContainText("回收站");
  await expect(deleteDialog).toContainText("评论");
  await expect(deleteDialog).toContainText("所有语言版本");

  // Cancelling is a no-op. The old `window.confirm` answered "Cancel" with the
  // same `false` this dialog answers with, and a replacement whose escape hatch
  // deletes anyway would be worse than the blocking dialog it replaced.
  await deleteDialog.getByRole("button", { name: "取消" }).click();
  await expect(deleteDialog).not.toBeVisible();
  await page.goto(`/articles/${slug}`);
  await expect(
    publicHeading,
    "cancelling the confirmation must leave the work published",
  ).toBeVisible({ timeout: 45_000 });

  // The destructive answer has to be aimed at: back into the desk, open the
  // work again, and this time say yes.
  await page.goto("/write");
  await waitForEditor(page);
  await entry.click();
  await waitForEditor(page);
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");

  // The notice belongs to the desk, not to the editor: the editor is reset to a
  // new document, so a message that only the editor could show would vanish with
  // the work it is about.
  await expect(
    page.getByRole("status").filter({ hasText: "已删除" }),
  ).toContainText(title, { timeout: 45_000 });
  await expect(async () => {
    const saved = await savedArticles(page);
    expect(
      saved.find((article) => article.title === title),
      JSON.stringify(saved),
    ).toBeUndefined();
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });

  // The durable outcome a reader can see: the address stops serving the work.
  await page.goto(`/articles/${slug}`);
  await expect(
    publicHeading,
    `the deleted work must not be readable at /articles/${slug}`,
  ).toHaveCount(0);
});

test("a deleted work can be restored from the recycle bin, as a draft", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  const title = `浏览器验证还原 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  await page.goto("/write");
  await waitForEditor(page);
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await entry.click();
  await waitForEditor(page);
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");
  await expect(
    page.getByRole("status").filter({ hasText: "已删除" }),
  ).toContainText(title, { timeout: 45_000 });

  // The deletion is not the end of the story: the work is in the recycle bin,
  // with a deadline the author can read, and it can be brought back.
  const trash = page.getByRole("region", { name: "回收站" });
  const row = trash.getByRole("button", {
    name: new RegExp(`还原《${title}》`),
  });
  await expect(row).toBeVisible({ timeout: 45_000 });
  await expect(trash).toContainText(/将在 \d+ 天后自动清除|即将自动清除/);

  await row.click();
  await expect(
    page.getByRole("status").filter({ hasText: "已还原" }),
  ).toContainText(title, { timeout: 45_000 });

  // Back in the desk, as a draft, with its body intact: a restore is an undo,
  // not a fresh document.
  await expect(async () => {
    const saved = await savedArticles(page);
    expect(
      saved.find((article) => article.title === title)?.status,
      JSON.stringify(saved),
    ).toBe("draft");
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await waitForEditor(page);
  await expect(page.getByLabel("作品正文")).toContainText(
    "第一段用来验证保存链路。",
    { timeout: 45_000 },
  );

  // Restoring must not republish: the address stays dark until the author says
  // otherwise, which is the whole difference between a restore and an archive.
  await page.goto(`/articles/${slug}`);
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
    `a restored draft must not be readable at /articles/${slug}`,
  ).toHaveCount(0);
});

test("a reader who commented on a deleted work is told so in their own desk", async ({
  page,
  request,
}) => {
  // Two accounts, one browser: the author who deletes, and the reader whose
  // comment goes with the work.
  await registerWriter(page, request);
  const title = `浏览器验证通知 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  const readerEmail = uniqueEmail("reader");
  const registered = await request.post(
    `${API_BASE_URL}/api/v1/auth/register`,
    {
      data: { email: readerEmail, password: PASSWORD },
    },
  );
  expect(
    registered.status(),
    `registering ${readerEmail}: ${await registered.text()}`,
  ).toBe(201);
  const { accessToken } = (await registered.json()).data as {
    accessToken: string;
  };

  // The reader's words, posted through the API because the journey is about the
  // inbox rather than the comment form: every click that is not what the test
  // asserts is a way for it to fail for the wrong reason.
  const comment = await request.post(
    `${API_BASE_URL}/api/v1/articles/${slug}/comments`,
    {
      data: { content: "这一段我想再读一遍。" },
      headers: { authorization: `Bearer ${accessToken}`, origin: API_BASE_URL },
    },
  );
  expect(
    comment.status(),
    `commenting on ${slug}: ${await comment.text()}`,
  ).toBe(201);

  await page.goto("/write");
  await waitForEditor(page);
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await entry.click();
  await waitForEditor(page);
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");
  await expect(
    page.getByRole("status").filter({ hasText: "已删除" }),
  ).toContainText(title, { timeout: 45_000 });

  // The author receives the reader's comment, but not their own deletion notice.
  const authorInbox = page.getByRole("region", { name: "通知" });
  await expect(authorInbox).toContainText("有人评论了你的作品。", {
    timeout: 45_000,
  });
  await expect(authorInbox).not.toContainText("你评论过的一篇作品已被作者删除");

  // The same screen, the other account.
  await page.context().clearCookies();
  await signIn(page, readerEmail);
  await page.goto("/write");
  await waitForEditor(page);

  const inbox = page.getByRole("region", { name: "通知" });
  await expect(
    inbox,
    `the reader's desk must carry the notice:\n${await pageDigest(page)}`,
  ).toContainText("1 未读", { timeout: 45_000 });
  await expect(inbox).toContainText(/你评论过的一篇作品已被作者删除/);
  // The date is the point of the notice: it is the difference between "this is
  // happening" and "this will happen, and here is when".
  await expect(inbox).toContainText(/你的评论会在 \d{4}-\d{2}-\d{2}/);

  // Marking it read is the reader's answer to it, and the badge follows: an
  // inbox that kept saying "1 未读" after being read would be the one part of
  // this screen a reader comes back to.
  // `exact`: the inbox's own "全部标为已读" also contains these characters.
  await inbox.getByRole("button", { name: "标记已读", exact: true }).click();
  await expect(
    inbox.getByRole("button", { name: "标记已读", exact: true }),
    `the notice must stop asking to be read:\n${await pageDigest(page)}`,
  ).toHaveCount(0, { timeout: 45_000 });
  await expect(
    inbox.getByRole("heading", { name: "通知", exact: true }),
  ).toBeVisible();
  await expect(inbox).toContainText(
    "已载入 1 条，其中 0 条未读；全收件箱 0 条未读。",
  );
  await expect(
    inbox.getByRole("button", { name: "全部标为已读", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".nw-bdg")).toHaveCount(0);
  // Read, not erased: the notice stays until the API's own retention takes it.
  await expect(inbox).toContainText(/你评论过的一篇作品已被作者删除/);
});

test("text committed by an IME reaches the editor state and is saved", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const title = `浏览器验证输入法 ${Date.now().toString(36)}`;
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("作品正文").click();
  // An IME commits a candidate with an `input` event and no keydown/keyup pair
  // for the characters it produced. `insertText` is exactly that shape, so a
  // composition bug that only shows up with a Chinese IME is reachable from CI
  // instead of only from a desktop with an IME installed.
  await page.keyboard.insertText(FIRST_PARAGRAPH);
  await expect(page.getByLabel("作品正文")).toContainText(
    "第一段用来验证保存链路。",
  );
  await page.getByRole("button", { name: "保存草稿" }).click();
  await savedSlug(page, title, "draft");

  // It has to survive the round trip, not just the screen: reopening the work
  // rebuilds the editor from the blocks the API stored.
  await page.reload();
  await waitForEditor(page);
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.getByLabel("作品正文")).toContainText(
    "第一段用来验证保存链路。",
    { timeout: 45_000 },
  );
});

test("formatting applied without a mouse survives the save round trip", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const title = `浏览器验证键盘 ${Date.now().toString(36)}`;
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("作品正文").click();
  await page.keyboard.type(FIRST_PARAGRAPH);
  await expect(page.getByLabel("作品正文")).toContainText(
    "第一段用来验证保存链路。",
  );

  // Keyboard only: select the paragraph, then bold it with the editor's own
  // shortcut — no pointer. A toolbar that answers only the mouse is not
  // accessible, and this is the keyboard path the editor itself provides.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+B");
  await expect(page.getByLabel("作品正文").locator("strong")).toContainText(
    "第一段用来验证保存链路。",
    { timeout: 30_000 },
  );

  // The article contract carries inline marks, so what the keyboard applied has
  // to come back when the work is reopened, not only stay on this screen.
  await page.getByRole("button", { name: "保存草稿" }).click();
  await savedSlug(page, title, "draft");
  await page.reload();
  await waitForEditor(page);
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.getByLabel("作品正文").locator("strong")).toContainText(
    "第一段用来验证保存链路。",
    { timeout: 45_000 },
  );
});

test("an article with no body is refused with a readable message instead of a silent failure", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  await page
    .getByLabel("标题")
    .fill(`浏览器验证空正文 ${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "保存草稿" }).click();
  try {
    // Filtered by text: Next keeps an empty route announcer in the tree that
    // also carries role=alert.
    await expect(
      page.getByRole("alert").filter({ hasText: "正文内容" }),
    ).toBeVisible({ timeout: 30_000 });
  } catch (caught) {
    throw new Error(
      `the editor did not refuse an empty body; page:\n${await pageDigest(page)}\n${String(caught)}`,
    );
  }
  expect(await savedArticles(page)).toHaveLength(0);
});
