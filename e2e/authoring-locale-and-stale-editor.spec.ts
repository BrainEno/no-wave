/**
 * Authoring across locales, and a stale editor that must not overwrite a newer
 * revision. The journey itself is in `authoring.spec.ts`; the helpers are in
 * `support/authoring-desk.ts`.
 */
import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import {
  currentOrigin,
  registerWriter,
  waitForEditor,
  writeAndSave,
  answerDeskDialog,
  simulatedArticle,
  registerDeskTraffic,
} from "./support/authoring-desk.ts";

registerDeskTraffic();

test("English and historical Traditional Chinese editions remain discoverable, editable and restorable", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);

  const english = `English locale journey ${Date.now().toString(36)}`;
  await page.getByLabel("作品语言").selectOption("en");
  await page.getByLabel("标题").fill(english);
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("An English work survives a reload.");
  const creation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/authoring/articles") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "发布作品" }).click();
  const createdResponse = await creation;
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  const created = (await createdResponse.json()).data as {
    id: string;
    slug: string;
    locale: string;
  };
  expect(created.locale).toBe("en");
  await expect(
    page.getByRole("status").filter({ hasText: "作品已发布。" }),
  ).toContainText(`/en/articles/${created.slug}`);
  await expect(
    page.getByRole("link", { name: "查看已发布作品" }),
  ).toHaveAttribute("href", `/en/articles/${created.slug}`);

  // This is the real public page, not just a plausible-looking success address.
  await page.goto(`/en/articles/${created.slug}`);
  await expect(
    page.getByRole("heading", { level: 1, name: english }),
  ).toBeVisible({ timeout: 45_000 });
  await page.goto("/write");
  await waitForEditor(page);
  const shelf = page.getByRole("complementary", { name: "我的作品" });
  await expect(
    shelf.getByRole("button", { name: new RegExp(english) }),
  ).toBeVisible();
  await shelf.getByRole("button", { name: new RegExp(english) }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("en");
  await expect(page.getByLabel("作品正文")).toContainText(
    "An English work survives a reload.",
  );
  await page.getByLabel("标题").fill("Edited English edition");
  await page.getByLabel("作品正文").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" And later editing.");
  const update = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/authoring/articles/${created.id}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存更新" }).click();
  expect((await update).status()).toBe(200);
  await expect(
    page.getByRole("status").filter({ hasText: "作品已发布。" }),
  ).toBeVisible();

  // Explicitly choosing another locale adds a translation to this same id.
  // Both editions must be separately selectable; switching back must remount
  // the correct document rather than leaving the previous edition's content.
  await page.getByLabel("作品语言").selectOption("zh-CN");
  await page.getByLabel("标题").fill("同一作品的中文译本");
  await page.getByLabel("作品正文").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("独立的中文正文。");
  let translationWrites = 0;
  page.on("request", (req) => {
    if (
      req.url().includes(`/api/authoring/articles/${created.id}`) &&
      req.method() === "PUT"
    )
      translationWrites += 1;
  });
  await page.getByRole("button", { name: "保存更新" }).click();
  const languageWarning = page.getByRole("dialog", {
    name: "保存到其他语言？",
  });
  await expect(languageWarning).toContainText("已有版本");
  await languageWarning.getByRole("button", { name: "取消" }).click();
  expect(translationWrites, "cancelling cannot overwrite another edition").toBe(
    0,
  );
  await expect(page.getByLabel("标题")).toHaveValue("同一作品的中文译本");
  const translation = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/authoring/articles/${created.id}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存更新" }).click();
  await languageWarning.getByRole("button", { name: "确认保存" }).click();
  expect((await translation).status()).toBe(200);
  await expect(
    shelf.getByRole("button", { name: /Edited English edition/ }),
  ).toBeVisible();
  await expect(
    shelf.getByRole("button", { name: /同一作品的中文译本/ }),
  ).toBeVisible();
  await shelf.getByRole("button", { name: /Edited English edition/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("en");
  await expect(page.getByLabel("作品正文")).toContainText("And later editing.");
  // A target translation now exists. Cancelling the warning must leave it intact.
  await page.getByLabel("作品语言").selectOption("zh-CN");
  await page.getByRole("button", { name: "保存更新" }).click();
  await expect(languageWarning).toBeVisible();
  await languageWarning.getByRole("button", { name: "取消" }).click();
  expect(translationWrites).toBe(1);
  await shelf.getByRole("button", { name: /同一作品的中文译本/ }).click();
  // Cancelling a translation save leaves the locale edit unsaved. Switching
  // editions must now ask before discarding it, without weakening the existing
  // translation-content and work-level deletion assertions below.
  const leaveWarning = page.getByRole("dialog", { name: "放弃未保存的修改？" });
  await expect(leaveWarning).toBeVisible();
  await leaveWarning.getByRole("button", { name: "取消" }).click();
  await expect(page.getByLabel("作品正文")).toContainText("And later editing.");
  await shelf.getByRole("button", { name: /同一作品的中文译本/ }).click();
  await leaveWarning.getByRole("button", { name: "放弃修改并切换" }).click();
  expect(
    translationWrites,
    "discarding local input cannot save or overwrite a translation",
  ).toBe(1);
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-CN");
  await expect(page.getByLabel("作品正文")).toContainText("独立的中文正文。");

  // Deletion is at work level, so the two language rows leave together and a
  // restore brings both back. Switching to a sibling edition while the delete
  // is in flight must still reset that now-deleted editor.
  let releaseDelete!: () => void;
  let deletedOnServer!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const deleteCommitted = new Promise<void>((resolve) => {
    deletedOnServer = resolve;
  });
  await page.route(`**/api/authoring/articles/${created.id}`, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    deletedOnServer();
    await deleteGate;
    await route.fulfill({ response });
  });
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/authoring/articles/${created.id}`) &&
      response.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  const languageDelete = page.getByRole("dialog", { name: /删除《.*》？/ });
  await expect(languageDelete).toContainText("所有语言版本");
  await languageDelete.getByRole("button", { name: "确认删除" }).click();
  await deleteCommitted;
  await shelf.getByRole("button", { name: /Edited English edition/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("en");
  releaseDelete();
  expect((await deleteResponse).status()).toBe(200);
  await expect(page.getByLabel("标题")).toHaveValue("");
  const trash = page.getByRole("region", { name: "回收站" });
  await expect(
    trash.getByRole("button", { name: "还原《Edited English edition》" }),
  ).toBeVisible();
  await expect(
    trash.getByRole("button", { name: "还原《同一作品的中文译本》" }),
  ).toBeVisible();
  await trash
    .getByRole("button", { name: "还原《Edited English edition》" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "已还原" }),
  ).toContainText("Edited English edition");
  await expect(
    shelf.getByRole("button", { name: /Edited English edition/ }),
  ).toBeVisible();
  await expect(
    shelf.getByRole("button", { name: /同一作品的中文译本/ }),
  ).toBeVisible();

  // Seed an existing zh-TW edition through the real proxy/API; the desk does
  // not offer that retired locale for a new work, but must preserve old rows.
  // zh-TW cannot be created directly (issue #417). The legacy edition is added
  // to a simplified work through the update route, which still accepts it.
  const legacyTitle = "原有繁體中文作品";
  const legacySlug = `historic-${Date.now().toString(36)}`;
  const seededWork = await page.request.post("/api/authoring/articles", {
    headers: { origin: currentOrigin() },
    data: {
      slug: legacySlug,
      title: "原有简体中文作品",
      locale: "zh-CN",
      publish: false,
      contentBlocks: [
        { id: "p1", type: "paragraph", text: "原有的简体正文。" },
      ],
    },
  });
  expect(seededWork.status(), await seededWork.text()).toBe(201);
  const legacyId = ((await seededWork.json()).data as { id: string }).id;
  const legacy = await page.request.put(`/api/authoring/articles/${legacyId}`, {
    headers: { origin: currentOrigin() },
    data: {
      slug: legacySlug,
      title: legacyTitle,
      locale: "zh-TW",
      publish: false,
      contentBlocks: [
        { id: "p1", type: "paragraph", text: "原有的繁體正文。" },
      ],
    },
  });
  expect(legacy.status(), await legacy.text()).toBe(200);
  await page.reload();
  await waitForEditor(page);
  await expect(
    page.getByLabel("作品语言").locator('option[value="zh-TW"]'),
  ).toHaveCount(0);
  await expect(
    shelf.getByRole("button", { name: new RegExp(legacyTitle) }),
  ).toBeVisible();
  await shelf.getByRole("button", { name: new RegExp(legacyTitle) }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-TW");
  await expect(page.getByLabel("作品正文")).toContainText("原有的繁體正文。");
  // Looking at another option must not make the stored legacy option disappear.
  await page.getByLabel("作品语言").selectOption("en");
  await page.getByLabel("作品语言").selectOption("zh-TW");
  await expect(page.getByLabel("作品正文")).toContainText("原有的繁體正文。");
  await page.getByLabel("标题").fill("編輯後的繁體中文作品");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible();
  const traditional = await page.request.get(
    "/api/authoring/articles?locale=zh-TW",
  );
  expect(traditional.status()).toBe(200);
  const traditionalWorks = (await traditional.json()).data as {
    locale: string;
    title: string;
  }[];
  expect(traditionalWorks).toContainEqual(
    expect.objectContaining({ locale: "zh-TW", title: "編輯後的繁體中文作品" }),
  );
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");
  await expect(
    trash.getByRole("button", { name: "还原《編輯後的繁體中文作品》" }),
  ).toBeVisible();
  await trash
    .getByRole("button", { name: "还原《編輯後的繁體中文作品》" })
    .click();
  await expect(
    shelf.getByRole("button", { name: /編輯後的繁體中文作品/ }),
  ).toBeVisible();
  await shelf.getByRole("button", { name: /編輯後的繁體中文作品/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-TW");
  await expect(page.getByLabel("作品正文")).toContainText("原有的繁體正文。");

  // An update can finish after the author opens another work. Its old callback
  // must not replace the selected identity under the newly mounted editor.
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route(`**/api/authoring/articles/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response });
  });
  await shelf.getByRole("button", { name: /Edited English edition/ }).click();
  await page.getByLabel("标题").fill("English update in flight");
  const oldSave = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/authoring/articles/${created.id}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存草稿" }).click();
  await committed;
  await shelf.getByRole("button", { name: /編輯後的繁體中文作品/ }).click();
  await expect(leaveWarning).toBeVisible();
  await leaveWarning.getByRole("button", { name: "放弃修改并切换" }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-TW");
  release();
  expect((await oldSave).status()).toBe(200);
  await expect(
    shelf.getByRole("button", { name: /English update in flight/ }),
  ).toBeVisible();
  await expect(
    shelf.getByRole("button", { name: /編輯後的繁體中文作品/ }),
  ).toHaveAttribute("aria-current", "true");
  await page.getByLabel("标题").fill("仍在編輯的繁體作品");
  const legacySave = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/authoring/articles/${legacyId}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存草稿" }).click();
  expect((await legacySave).status()).toBe(200);
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible();

  // Deleting a different work while this one is opened has the opposite rule:
  // the late completion must not reset the current editor or its typed content.
  let releaseOtherDelete!: () => void;
  let otherDeleted!: () => void;
  const otherGate = new Promise<void>((resolve) => {
    releaseOtherDelete = resolve;
  });
  const otherCommitted = new Promise<void>((resolve) => {
    otherDeleted = resolve;
  });
  await page.route(`**/api/authoring/articles/${created.id}`, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    otherDeleted();
    await otherGate;
    await route.fulfill({ response });
  });
  await shelf.getByRole("button", { name: /English update in flight/ }).click();
  const otherDelete = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/authoring/articles/${created.id}`) &&
      response.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");
  await otherCommitted;
  await shelf.getByRole("button", { name: /仍在編輯的繁體作品/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-TW");
  await page.getByLabel("标题").fill("尚未保存的繁體修改");
  releaseOtherDelete();
  expect((await otherDelete).status()).toBe(200);
  await expect(
    shelf.getByRole("button", { name: /English update in flight/ }),
  ).toHaveCount(0);
  await expect(page.getByLabel("标题")).toHaveValue("尚未保存的繁體修改");
  await expect(
    shelf.getByRole("button", { name: /仍在編輯的繁體作品/ }),
  ).toHaveAttribute("aria-current", "true");
});

test("an older API cannot silently present a single locale as the complete writing desk", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await page.route(
    (url) =>
      url.pathname === "/api/authoring/articles" &&
      url.searchParams.get("allLocales") === "true",
    async (route) => {
      // The old API ignores the unknown query and returns an apparently valid
      // zh-CN-only list. Treating this as complete would hide existing editions.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      });
    },
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("无法确认所有语言版本");
  await expect(page.getByText("还没有草稿或已发布作品。")).toHaveCount(0);
});

test("a success response with the wrong language cannot retire an uncertain create", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    const data = simulatedArticle(route.request().postData());
    if (attempts.length === 1) data.locale = "zh-CN";
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });
  await page.getByLabel("作品语言").selectOption("en");
  await page.getByLabel("标题").fill("Wrong language response");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("The original intent must remain available.");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  await expect(page.getByRole("button", { name: "新建作品 +" })).toBeDisabled();
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "上次创建已确认" }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(JSON.parse(attempts[0].body!).locale).toBe("en");
});

test("a stale editor keeps its draft and cannot overwrite another window's saved revision", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await writeAndSave(page, "条件保存测试", false);
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible();
  const [article] = (
    await (await page.request.get("/api/authoring/articles")).json()
  ).data;
  expect(typeof article.revision).toBe("string");
  const remote = await page.request.put(
    `/api/authoring/articles/${article.id}`,
    {
      headers: { origin: currentOrigin() },
      data: {
        slug: article.slug,
        title: "其他窗口的最新作品",
        locale: article.locale,
        publish: false,
        expectedRevision: article.revision,
        contentBlocks: [
          { id: "remote", type: "paragraph", text: "远端新正文。" },
        ],
      },
    },
  );
  expect(remote.status()).toBe(200);
  await page.getByLabel("标题").fill("需要保留的本地草稿");
  await page.getByLabel("作品正文").fill("当前窗口里尚未保存的正文。");
  const response = page.waitForResponse(
    (result) =>
      result.request().method() === "PUT" &&
      result.url().endsWith(`/api/authoring/articles/${article.id}`),
  );
  await page.getByRole("button", { name: "保存草稿" }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole("alert")).toContainText(
    "当前草稿仍保留，请先复制备份",
  );
  await expect(page.getByLabel("标题")).toHaveValue("需要保留的本地草稿");
  await expect(page.getByLabel("作品正文")).toContainText(
    "当前窗口里尚未保存的正文。",
  );
  const [kept] = (
    await (await page.request.get("/api/authoring/articles")).json()
  ).data;
  expect(kept.title).toBe("其他窗口的最新作品");
  expect(JSON.stringify(kept.contentBlocks)).toContain("远端新正文。");
});
