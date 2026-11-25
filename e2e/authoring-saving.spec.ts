/**
 * Authoring saves: create retries, uncertain saves and replays, one key per
 * draft. The journey itself is in `authoring.spec.ts`; the helpers are in
 * `support/authoring-desk.ts`.
 */
import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import {
  PASSWORD,
  API_BASE_URL,
  currentOrigin,
  uniqueEmail,
  signIn,
  registerWriter,
  waitForEditor,
  savedArticles,
  answerDeskDialog,
  simulatedArticle,
  registerDeskTraffic,
} from "./support/authoring-desk.ts";

registerDeskTraffic();

test("first save retries one committed work, later saves update it, and another draft gets a new key", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  const updates: (string | undefined)[] = [];
  let committedId = "";

  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    if (attempts.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      committedId = (await committed.json()).data.id as string;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/authoring/articles/*", async (route) => {
    if (route.request().method() === "PUT")
      updates.push(route.request().headers()["idempotency-key"]);
    await route.continue();
  });

  await page.getByLabel("标题").fill("一次保存，只有一篇");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("断线重试不应该产生第二篇作品。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(committedId).toBeTruthy();
  expect(attempts).toHaveLength(1);
  expect(attempts[0].key).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "上次创建已确认" }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([
    committedId,
  ]);

  await page.getByLabel("标题").fill("保存后的更新");
  const update = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/authoring/articles/${committedId}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存草稿" }).click();
  expect((await update).status()).toBe(200);
  expect(updates).toEqual([undefined]);
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([
    committedId,
  ]);

  await page.getByRole("button", { name: "新建作品 +" }).click();
  await waitForEditor(page);
  await page.getByLabel("标题").fill("独立的新草稿");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("另一篇作品有另一把键。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible();
  expect(attempts).toHaveLength(3);
  expect(attempts[2].key).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(attempts[2].key).not.toBe(attempts[0].key);
  expect(await savedArticles(page)).toHaveLength(2);
});

test("an uncertain save keeps its original body, blocks document switches and preserves subsequent edits", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  const updates: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  let stored!: () => void;
  const committed = new Promise<void>((resolve) => {
    stored = resolve;
  });
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).data.id as string;
      stored();
      await responseGate;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/authoring/articles/*", async (route) => {
    if (route.request().method() === "PUT")
      updates.push({
        key: route.request().headers()["idempotency-key"],
        body: route.request().postData(),
      });
    await route.continue();
  });

  await page.getByLabel("标题").fill("原来的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("原来的正文。");
  // Two events before React has a chance to render its disabled button.
  await page
    .getByRole("button", { name: "保存草稿" })
    .evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
  await committed;
  expect(attempts).toHaveLength(1);
  await expect(page.getByRole("button", { name: "新建作品 +" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeDisabled();
  await page.getByLabel("标题").fill("后来修改的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.press("End");
  await page.keyboard.type("后来修改的正文。");
  release();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  await expect(
    page.getByRole("link", { name: "在新标签页核对作品列表" }),
  ).toHaveAttribute("target", "_blank");

  const leavingPage = page.waitForEvent("dialog");
  const reload = page
    .evaluate(() => window.location.reload())
    .catch(() => null);
  const unloadWarning = await leavingPage;
  expect(unloadWarning.type()).toBe("beforeunload");
  await unloadWarning.dismiss();
  await reload;

  // A client-side link must not quietly discard the only copy of the pending
  // key or the author's unsaved edits.
  await page.getByRole("link", { name: "媒体库" }).click();
  const leave = page.getByRole("dialog", { name: "上次保存尚未确认" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "取消" }).click();
  await expect(leave).not.toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/write");

  // Publishing the edited form is not a retry of saving the original draft.
  await page.getByRole("button", { name: "发布作品" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts).toHaveLength(1);
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "当前修改尚未保存" }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(page.getByLabel("标题")).toHaveValue("后来修改的标题");
  await expect(page.getByLabel("作品正文")).toContainText("后来修改的正文。");
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([
    committedId,
  ]);

  const publish = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/authoring/articles/${committedId}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "发布作品" }).click();
  expect((await publish).status()).toBe(200);
  await expect(
    page.getByRole("status").filter({ hasText: "作品已发布。" }),
  ).toBeVisible();
  expect(updates).toHaveLength(1);
  expect(updates[0].key).toBeUndefined();
  expect(JSON.parse(updates[0].body!).title).toBe("后来修改的标题");
  const saved = await savedArticles(page);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    id: committedId,
    title: "后来修改的标题",
    status: "published",
  });
});

test("an unconfirmed create cannot be retried under a different signed-in account", async ({
  page,
  request,
}) => {
  const originalEmail = await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).data.id as string;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("标题").fill("只属于原账户的作品");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("这次重试不能写到另一个账户。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");

  const otherEmail = uniqueEmail("another-writer");
  const registered = await request.post(
    `${API_BASE_URL}/api/v1/auth/register`,
    { data: { email: otherEmail, password: PASSWORD } },
  );
  expect(registered.status()).toBe(201);
  await signIn(page, otherEmail);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("账户已变化");
  expect(await savedArticles(page)).toHaveLength(0);
  expect(attempts[1]).toEqual(attempts[0]);

  await signIn(page, originalEmail);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "上次创建已确认" }),
  ).toBeVisible();
  expect(attempts[2]).toEqual(attempts[0]);
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([
    committedId,
  ]);
});

test("401, conflict and malformed success never silently replace an uncertain create key", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let replay: ReturnType<typeof simulatedArticle> | null = null;
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    if (attempts.length === 1) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"error":{"code":"UNAUTHENTICATED"}}',
      });
    } else if (attempts.length === 2) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: '{"error":{"code":"IDEMPOTENCY_CONFLICT"}}',
      });
    } else if (attempts.length === 3) {
      replay = simulatedArticle(attempts[2].body);
      // Superficially plausible, but missing locale, type and document version.
      const { id, slug, title, status, contentBlocks } = replay;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          data: { id, slug, title, status, contentBlocks },
        }),
      });
    } else {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ data: replay }),
      });
    }
  });
  await page.getByLabel("标题").fill("异常后的恢复");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("不能把不确定的响应当成没有保存。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("登录");
  await expect(page.getByRole("alert").getByRole("link")).toHaveAttribute(
    "target",
    "_blank",
  );
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("冲突");
  expect(attempts[1]).toEqual(attempts[0]);
  await page.getByRole("button", { name: "放弃上次未确认的请求" }).click();
  const discard = page.getByRole("dialog", { name: "放弃未确认的保存？" });
  await expect(discard).toContainText("可能已经创建");
  await discard.getByRole("button", { name: "确认放弃" }).click();
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  expect(attempts[2].key).not.toBe(attempts[1].key);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "上次创建已确认" }),
  ).toBeVisible();
  expect(attempts[3]).toEqual(attempts[2]);
  await expect(page.getByLabel("标题")).toHaveValue("异常后的恢复");
});

test("a locally rejected initial request permits a corrected first save", async ({
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
    if (attempts.length === 1) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: { "x-authoring-not-forwarded": "1" },
        body: '{"error":{"code":"BAD_USER_INPUT","message":"Please correct the input."}}',
      });
    } else {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ data: simulatedArticle(attempts[1].body) }),
      });
    }
  });
  await page.getByLabel("标题").fill("需要修正的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("修正前的正文。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Please correct the input.",
  );
  await page.getByLabel("标题").fill("修正后的标题");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1].key).not.toBe(attempts[0].key);
  expect(JSON.parse(attempts[1].body!).title).toBe("修正后的标题");
});

test("a later 400 cannot erase a previously uncertain create", async ({
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
    if (attempts.length === 1) {
      // No answer proves whether this first attempt reached the server.
      await route.abort("failed");
    } else if (attempts.length === 2) {
      // The retry itself never left the proxy, but the first might have.
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: { "x-authoring-not-forwarded": "1" },
        body: '{"error":{"code":"BAD_USER_INPUT","message":"rejected"}}',
      });
    } else {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ data: simulatedArticle(attempts[0].body) }),
      });
    }
  });
  await page.getByLabel("标题").fill("仍需确认的作品");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("稍后拒绝不等于第一次没有提交。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts[1]).toEqual(attempts[0]);
  await page.getByLabel("标题").fill("修改后的标题");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts).toHaveLength(2);
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "当前修改尚未保存" }),
  ).toBeVisible();
  expect(attempts[2]).toEqual(attempts[0]);
  await expect(page.getByLabel("标题")).toHaveValue("修改后的标题");
});

test("editing while the first save succeeds is not reported as already saved", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  let received!: () => void;
  const arrived = new Promise<void>((resolve) => {
    received = resolve;
  });
  let simulated: ReturnType<typeof simulatedArticle> | null = null;
  const creates: string[] = [];
  const updates: string[] = [];
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    creates.push(route.request().postData() ?? "");
    simulated = simulatedArticle(creates[0]);
    received();
    await responseGate;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: simulated }),
    });
  });
  await page.route("**/api/authoring/articles/*", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    updates.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: simulatedArticle(updates[0], simulated!) }),
    });
  });
  await page.getByLabel("标题").fill("已发送的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("已发送的正文。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await arrived;
  await page.getByLabel("标题").fill("保存期间的新标题");
  release();
  await expect(
    page.getByRole("status").filter({ hasText: "当前修改尚未保存" }),
  ).toBeVisible();
  await expect(page.getByLabel("标题")).toHaveValue("保存期间的新标题");
  expect(JSON.parse(creates[0]).title).toBe("已发送的标题");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).not.toContainText("当前修改尚未保存");
  expect(updates).toHaveLength(1);
  expect(JSON.parse(updates[0]).title).toBe("保存期间的新标题");
});

test("even an initial 400 can follow a commit and must not silently retire the key", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).data.id as string;
      // An error while serializing a response can be reported after the write.
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: '{"error":{"code":"BAD_USER_INPUT","message":"response failed"}}',
      });
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("标题").fill("第一次返回错误但已提交");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("错误状态并不一定证明没有创建。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  await page.getByLabel("标题").fill("修改后的文本");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts).toHaveLength(1);
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "当前修改尚未保存" }),
  ).toBeVisible();
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([
    committedId,
  ]);
});

test("a replay reports the server's current version without claiming the open editor saved over it", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  let slug = "";
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const data = (await response.json()).data as { id: string; slug: string };
      committedId = data.id;
      slug = data.slug;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("标题").fill("此页面原来的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("此页面原来的正文。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");

  // Simulate another tab editing the committed work before the lost-response
  // retry. Replay returns the current resource, not the first response bytes.
  const otherBody = {
    ...JSON.parse(attempts[0].body!),
    slug,
    title: "其他页面的新标题",
  };
  const other = await page.request.put(
    `/api/authoring/articles/${committedId}`,
    {
      headers: { origin: currentOrigin() },
      data: otherBody,
    },
  );
  expect(other.status()).toBe(200);
  await page.getByRole("button", { name: "保存草稿" }).click();
  const status = page.getByRole("status").filter({ hasText: "上次创建已确认" });
  await expect(status).toContainText("服务器返回的是当前版本");
  await expect(
    status.getByRole("link", { name: "在新标签页核对服务器版本" }),
  ).toHaveAttribute("target", "_blank");
  await expect(page.getByLabel("标题")).toHaveValue("此页面原来的标题");
  expect(attempts[1]).toEqual(attempts[0]);
  expect(await savedArticles(page)).toMatchObject([
    { id: committedId, title: "其他页面的新标题" },
  ]);
});

test("changing only publish intent cannot reuse an uncertain create as a different request", async ({
  page,
  request,
}) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).data.id as string;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("标题").fill("发布状态也是保存意图的一部分");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("先发布，再决定是否撤回。");
  await page.getByRole("button", { name: "发布作品" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  expect(JSON.parse(attempts[0].body!).publish).toBe(true);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts).toHaveLength(1);
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "所选操作尚未执行" }),
  ).toBeVisible();
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await savedArticles(page))[0]).toMatchObject({
    id: committedId,
    status: "published",
  });
  await page.getByRole("button", { name: "撤销发布", exact: true }).click();
  await answerDeskDialog(page, "撤销发布？", "确认撤销发布");
  await expect(
    page.getByRole("status").filter({ hasText: "作品已撤销发布" }),
  ).toBeVisible();
  expect((await savedArticles(page))[0]).toMatchObject({
    id: committedId,
    status: "draft",
  });
});
