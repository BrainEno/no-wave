import { expect, test, type BrowserContext } from "@playwright/test";
import { editorState, publishWork, uniqueEmail, WORK_PASSWORD } from "./support/works.ts";

/** These journeys use the real cookie jar, Web resource routes, API and SQLite.
 * Manually constructing a Cookie header does not exercise the browser's Path
 * restriction and previously let authenticated controls look correct in tests. */
async function registerReader(context: BrowserContext, origin: string): Promise<void> {
  const response = await context.request.post(`${origin}/api/auth/register`, {
    headers: { origin },
    data: { email: uniqueEmail("reader"), password: "browser-reader-password" },
  });
  expect(response.status()).toBe(201);
}

async function refreshCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === "nw_refresh")?.value;
}

test("a signed-in reader can save, reload and remove a save", async ({ browser, page, request, baseURL }) => {
  const { slug } = await publishWork(request, `收藏旅程 ${Date.now().toString(36)}`, ["一篇真实发表的作品。"]);
  await registerReader(page.context(), new URL(baseURL!).origin);
  const refreshBefore = await refreshCookie(page.context());
  expect(Boolean(refreshBefore)).toBe(true);

  await page.goto(`/articles/${slug}`);
  let button = page.getByRole("button", { name: "收藏", exact: true });
  await expect(button).toBeEnabled();

  // Hold and reject one write: the optimistic press is visible immediately,
  // another press is disabled, and the actual failure rolls the state back.
  const writeRoute = `**/api/authoring/articles/${slug}/like?*`;
  let releaseWrite!: () => void;
  const hold = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => { writeStarted = resolve; });
  let writeCount = 0;
  await page.route(writeRoute, async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    writeCount += 1;
    writeStarted();
    await hold;
    await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
  });
  try {
    await button.click();
    await started;
    const optimistic = page.getByRole("button", { name: "已收藏", exact: true });
    await expect(optimistic).toHaveAttribute("aria-pressed", "true");
    await expect(optimistic).toBeDisabled();
    await expect(page.getByText("1 人收藏", { exact: true })).toBeVisible();
    expect(writeCount).toBe(1);
  } finally { releaseWrite(); }
  await expect(page.getByRole("alert").filter({ hasText: "收藏状态没能保存" })).toBeVisible();
  button = page.getByRole("button", { name: "收藏", exact: true });
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(button).toBeEnabled();
  await expect(page.getByText("还没有人收藏", { exact: true })).toBeVisible();
  await page.unroute(writeRoute);

  // The API commits this write but the response body is damaged. The result is
  // unknown until a fresh read confirms it; neither rollback nor the optimistic
  // guess is a safe basis for the next toggle.
  await page.route(writeRoute, async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ status: 200, json: { data: {} } });
  });
  await button.click();
  await expect(page.getByRole("alert").filter({ hasText: "收藏状态暂时无法读取" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "收藏", exact: true })).toBeDisabled();
  await page.unroute(writeRoute);
  await page.getByRole("button", { name: "重试读取收藏状态" }).click();
  button = page.getByRole("button", { name: "已收藏", exact: true });
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toBeEnabled();
  await expect(page.getByText("1 人收藏", { exact: true })).toBeVisible();

  const origin = new URL(baseURL!).origin;
  const rejected = await page.context().request.put(`${origin}/api/authoring/articles/${slug}/like?locale=zh-CN`, {
    headers: { origin: "https://other.example.test" }, data: { liked: false },
  });
  expect(rejected.status()).toBe(403);
  expect(rejected.headers()["cache-control"]).toContain("no-store");
  const own = await page.context().request.get(`${origin}/api/authoring/articles/${slug}/like?locale=zh-CN`);
  expect((await own.json()).data.likedByViewer).toBe(true);
  expect(own.headers()["cache-control"]).toContain("no-store");

  // The public count is shared, but another browser must never inherit this
  // reader's private flag. An anonymous press prompts sign-in and does not save.
  const visitor = await browser.newContext({ baseURL: origin });
  try {
    const other = await visitor.newPage();
    await other.goto(`/articles/${slug}`);
    const notSaved = other.getByRole("button", { name: "收藏", exact: true });
    await expect(notSaved).toBeEnabled();
    await expect(notSaved).toHaveAttribute("aria-pressed", "false");
    await expect(other.getByText("1 人收藏", { exact: true })).toBeVisible();
    await notSaved.click();
    await expect(other.getByText("登录后可以收藏作品。", { exact: false })).toBeVisible();
    await expect(other.getByRole("link", { name: "前往登录" })).toBeVisible();
    await expect(notSaved).toHaveAttribute("aria-pressed", "false");
  } finally { await visitor.close(); }

  await page.reload();
  button = page.getByRole("button", { name: "已收藏", exact: true });
  await expect(button).toHaveAttribute("aria-pressed", "true", { timeout: 8_000 });
  await expect(button).toBeEnabled();
  expect((await refreshCookie(page.context())) === refreshBefore, "valid access reads and writes must not rotate the session").toBe(true);

  // An expired access cookie disappears from the browser, while the renewable
  // session remains. A public upstream read would otherwise return an anonymous
  // 200, silently losing the reader's real save instead of refreshing.
  await page.context().clearCookies({ name: "nw_access" });
  const restored = await page.context().request.get(`${new URL(baseURL!).origin}/api/authoring/articles/${slug}/like?locale=zh-CN`);
  expect(restored.status()).toBe(200);
  expect((await restored.json()).data.likedByViewer).toBe(true);
  expect((await refreshCookie(page.context())) !== refreshBefore, "a missing access cookie must renew the session").toBe(true);
  const refreshAfter = await refreshCookie(page.context());

  // A failed read must not guess "not saved" and offer the wrong toggle.
  const likeRoute = `**/api/authoring/articles/${slug}/like?*`;
  let failedRead = false;
  await page.route(likeRoute, async (route) => {
    if (route.request().method() === "GET" && !failedRead) {
      failedRead = true;
      await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
    } else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "收藏状态暂时无法读取" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "收藏", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "重试读取收藏状态" }).click();
  button = page.getByRole("button", { name: "已收藏", exact: true });
  await expect(button).toBeEnabled();
  await page.unroute(likeRoute);
  await button.click();
  await expect(page.getByRole("button", { name: "收藏", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("还没有人收藏", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "收藏", exact: true })).toBeEnabled();
  expect((await refreshCookie(page.context())) === refreshAfter, "a valid access cookie must not rotate the refresh token").toBe(true);
});

test("following survives navigation and controls the reader's private feed", async ({ browser, page, request, baseURL }) => {
  const title = `关注旅程 ${Date.now().toString(36)}`;
  const { slug } = await publishWork(request, title, ["关注后，这篇作品应当出现。"]);
  await registerReader(page.context(), new URL(baseURL!).origin);
  const refreshBefore = await refreshCookie(page.context());
  expect(Boolean(refreshBefore)).toBe(true);

  await page.goto(`/articles/${slug}`);
  const authorLink = page.getByRole("link", { name: "无浪作者", exact: true }).first();
  const authorPath = await authorLink.getAttribute("href");
  expect(authorPath).toMatch(/^\/authors\//);
  await page.goto("/feed");
  await expect(page.getByText("你还没有关注任何作者，或者关注的作者还没有新作品。", { exact: true })).toBeVisible();
  await page.goto(authorPath!);
  let button = page.getByRole("button", { name: /^关注 / });
  await expect(button).toBeEnabled();
  const unfollowedStyle = await button.evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, borderStyle: style.borderTopStyle, borderWidth: parseFloat(style.borderTopWidth), height: el.getBoundingClientRect().height };
  });
  expect(unfollowedStyle.borderStyle).toBe("solid");
  expect(unfollowedStyle.borderWidth).toBeGreaterThan(0);
  expect(unfollowedStyle.height).toBeGreaterThanOrEqual(44);
  const userId = authorPath!.split("/").at(-1);
  const followRoute = `**/api/authoring/users/${userId}/follow?*`;
  let releaseWrite!: () => void;
  const hold = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => { writeStarted = resolve; });
  let writeCount = 0;
  await page.route(followRoute, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    writeCount += 1;
    writeStarted();
    await hold;
    await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
  });
  try {
    await button.click();
    await started;
    const optimistic = page.getByRole("button", { name: /^已关注 / });
    await expect(optimistic).toHaveAttribute("aria-pressed", "true");
    await expect(optimistic).toBeDisabled();
    expect(writeCount).toBe(1);
  } finally { releaseWrite(); }
  await expect(page.getByRole("alert").filter({ hasText: "关注状态没能保存" })).toBeVisible();
  button = page.getByRole("button", { name: /^关注 / });
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(button).toBeEnabled();
  await page.unroute(followRoute);
  // A successful write with an unusable response must be confirmed by reading
  // the real profile, not silently treated as either followed or unfollowed.
  await page.route(followRoute, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ status: 200, json: { data: {} } });
  });
  await button.click();
  await expect(page.getByRole("alert").filter({ hasText: "关注状态暂时无法读取" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "关注", exact: true })).toBeDisabled();
  await page.unroute(followRoute);
  await page.getByRole("button", { name: "重试读取关注状态" }).click();
  button = page.getByRole("button", { name: /^已关注 / });
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toBeEnabled();
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(unfollowedStyle.background);
  expect(await button.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);

  const origin = new URL(baseURL!).origin;
  const rejected = await page.context().request.delete(`${origin}/api/authoring/users/${userId}/follow?locale=zh-CN`, {
    headers: { origin: "https://other.example.test" },
  });
  expect(rejected.status()).toBe(403);
  expect(rejected.headers()["cache-control"]).toContain("no-store");

  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const anonymousFeed = await otherContext.request.get(`${origin}/api/authoring/feed?locale=zh-CN`);
    expect(anonymousFeed.status()).toBe(401);
    expect(anonymousFeed.headers()["cache-control"]).toContain("no-store");
    const other = await otherContext.newPage();
    await other.goto(authorPath!);
    const anonymousFollow = other.getByRole("button", { name: /^关注 / });
    await expect(anonymousFollow).toBeEnabled();
    await expect(anonymousFollow).toHaveAttribute("aria-pressed", "false");
    await anonymousFollow.click();
    await expect(other.getByText("登录后可以关注作者。", { exact: false })).toBeVisible();
    await expect(anonymousFollow).toHaveAttribute("aria-pressed", "false");
    await registerReader(otherContext, origin);
    await other.goto("/feed");
    await expect(other.getByText("你还没有关注任何作者，或者关注的作者还没有新作品。", { exact: true })).toBeVisible();
    await expect(other.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
  } finally { await otherContext.close(); }

  await page.goto("/feed");
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  expect((await refreshCookie(page.context())) === refreshBefore, "valid access reads and writes must not rotate the session").toBe(true);
  await page.context().clearCookies({ name: "nw_access" });
  const restored = await page.context().request.get(`${new URL(baseURL!).origin}/api/authoring/authors/${userId}?locale=zh-CN`);
  expect(restored.status()).toBe(200);
  expect((await restored.json()).data.isFollowing).toBe(true);
  expect((await refreshCookie(page.context())) !== refreshBefore, "a missing access cookie must renew the session").toBe(true);
  const refreshAfter = await refreshCookie(page.context());
  await page.goto(`/en/authors/${userId}`);
  await expect(page.getByRole("button", { name: /^Following / })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/en/feed");
  await expect(page.getByText("You are not following anyone yet, or they have not published anything new.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  // Failed or malformed profile reads are unknown, not an empty follow graph.
  const profileRoute = `**/api/authoring/authors/${userId}?*`;
  let failedRead = false;
  await page.route(profileRoute, async (route) => {
    if (!failedRead) {
      failedRead = true;
      await route.fulfill({ status: 200, json: { data: {} } });
    } else await route.continue();
  });
  await page.goto(authorPath!);
  await expect(page.getByRole("alert").filter({ hasText: "关注状态暂时无法读取" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "关注", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "重试读取关注状态" }).click();
  button = page.getByRole("button", { name: /^已关注 / });
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toBeEnabled();
  await page.unroute(profileRoute);
  await button.click();
  await expect(page.getByRole("button", { name: /^关注 / })).toHaveAttribute("aria-pressed", "false");
  await page.goto("/feed");
  await expect(page.getByText("你还没有关注任何作者，或者关注的作者还没有新作品。", { exact: true })).toBeVisible();
  expect((await refreshCookie(page.context())) === refreshAfter, "normal reads and writes must not rotate the session").toBe(true);
});

test("a late save response cannot change the next work's control", async ({ page, request, baseURL }) => {
  const firstTitle = `前一篇 ${Date.now().toString(36)}`;
  const nextTitle = `后一篇 ${Date.now().toString(36)}`;
  const { email, slug: first } = await publishWork(request, firstTitle, ["前一篇的正文。"]);
  const api = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";
  const login = await request.post(`${api}/api/v1/auth/login`, { data: { email, password: WORK_PASSWORD } });
  expect(login.status()).toBe(200);
  const accessToken = (await login.json()).data.accessToken as string;
  const created = await request.post(`${api}/api/v1/articles`, {
    headers: { authorization: `Bearer ${accessToken}` },
    data: { title: nextTitle, editorState: editorState(["后一篇的正文。"]), contentBlocksVersion: 1, publish: true },
  });
  expect(created.status()).toBe(201);
  const next = (await created.json()).data.slug as string;
  await registerReader(page.context(), new URL(baseURL!).origin);
  await page.goto(`/articles/${first}`);
  const save = page.getByRole("button", { name: "收藏", exact: true });
  await expect(save).toBeEnabled();

  const routePattern = `**/api/authoring/articles/${first}/like?*`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let committed!: () => void;
  const stored = new Promise<void>((resolve) => { committed = resolve; });
  let finished!: () => void;
  const delivered = new Promise<void>((resolve) => { finished = resolve; });
  await page.route(routePattern, async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed();
    await gate;
    await route.fulfill({ response });
    finished();
  });
  try {
    await save.click();
    await stored;
    // Navigate using a real client-side link while the response for the first
    // work is held, then let the second work load its own save state.
    await page.getByRole("link", { name: new RegExp(nextTitle) }).first().click();
    await expect(page).toHaveURL(new RegExp(`/articles/${next}$`));
    const nextSave = page.getByRole("button", { name: "收藏", exact: true });
    await expect(nextSave).toHaveAttribute("aria-pressed", "false");
    // A pending write for the previous work must not block this work either.
    await expect(nextSave).toBeEnabled();
  } finally { release(); }
  await delivered;
  // Let React process the response and paint before asserting the final state.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const nextSave = page.getByRole("button", { name: "收藏", exact: true });
  await expect(nextSave).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("还没有人收藏", { exact: true })).toBeVisible();
  const firstState = await page.context().request.get(`/api/authoring/articles/${first}/like?locale=zh-CN`);
  const nextState = await page.context().request.get(`/api/authoring/articles/${next}/like?locale=zh-CN`);
  expect((await firstState.json()).data.likedByViewer).toBe(true);
  expect((await nextState.json()).data.likedByViewer).toBe(false);
});

test("a late follow response cannot change another author's control", async ({ page, request, baseURL }) => {
  const firstTitle = `第一位作者 ${Date.now().toString(36)}`;
  const nextTitle = `第二位作者 ${Date.now().toString(36)}`;
  const firstWork = await publishWork(request, firstTitle, ["第一位作者的作品。"]);
  const nextWork = await publishWork(request, nextTitle, ["第二位作者的作品。"]);
  await registerReader(page.context(), new URL(baseURL!).origin);

  await page.goto(`/articles/${firstWork.slug}`);
  const firstPath = await page.getByRole("link", { name: "无浪作者", exact: true }).first().getAttribute("href");
  await page.goto(`/articles/${nextWork.slug}`);
  const nextPath = await page.getByRole("link", { name: "无浪作者", exact: true }).first().getAttribute("href");
  expect(firstPath).toMatch(/^\/authors\//);
  expect(nextPath).toMatch(/^\/authors\//);
  expect(firstPath).not.toBe(nextPath);

  await page.goto(nextPath!);
  await expect(page.getByRole("button", { name: /^关注 / })).toBeEnabled();
  // Create a same-route history entry, then use the browser's Back button for
  // the navigation under test. Author pages do not directly link each other.
  await page.getByRole("navigation", { name: "作品类型" }).getByRole("link", { name: "长篇小说" }).click();
  await expect(page).toHaveURL(/\?type=/);
  await page.evaluate((path) => {
    window.history.replaceState(window.history.state, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, firstPath!);
  await expect(page).toHaveURL(new RegExp(`${firstPath}$`));
  await expect(page.getByRole("link", { name: new RegExp(firstTitle) }).first()).toBeVisible();
  const follow = page.getByRole("button", { name: /^关注 / });
  await expect(follow).toBeEnabled();

  const firstId = firstPath!.split("/").at(-1);
  const pattern = `**/api/authoring/users/${firstId}/follow?*`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let committed!: () => void;
  const stored = new Promise<void>((resolve) => { committed = resolve; });
  let finished!: () => void;
  const delivered = new Promise<void>((resolve) => { finished = resolve; });
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed();
    await gate;
    await route.fulfill({ response });
    finished();
  });
  try {
    await follow.click();
    await stored;
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${nextPath}$`));
    await expect(page.getByRole("link", { name: new RegExp(nextTitle) }).first()).toBeVisible();
    const nextFollow = page.getByRole("button", { name: /^关注 / });
    await expect(nextFollow).toHaveAttribute("aria-pressed", "false");
    await expect(nextFollow).toBeEnabled();
  } finally { release(); }
  await delivered;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole("button", { name: /^关注 / })).toHaveAttribute("aria-pressed", "false");
  const nextId = nextPath!.split("/").at(-1);
  const firstState = await page.context().request.get(`/api/authoring/authors/${firstId}?locale=zh-CN`);
  const nextState = await page.context().request.get(`/api/authoring/authors/${nextId}?locale=zh-CN`);
  expect((await firstState.json()).data.isFollowing).toBe(true);
  expect((await nextState.json()).data.isFollowing).toBe(false);
});

test("an anonymous English reader returns to the same edition after signing in", async ({ page, request }) => {
  const { slug } = await publishWork(request, `English save ${Date.now().toString(36)}`, ["A reader can save this work."], "en");
  await page.goto(`/en/articles/${slug}`);
  const button = page.getByRole("button", { name: "Save", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText("Sign in to save this work.")).toBeVisible();
  const signIn = page.getByRole("link", { name: "Sign in", exact: true });
  await expect(signIn).toHaveAttribute("href", `/sign-in?next=${encodeURIComponent(`/en/articles/${slug}`)}`);
  await signIn.click();
  await expect(async () => {
    await page.getByRole("button", { name: /没有账户？创建账户/ }).click();
    await expect(page.getByRole("button", { name: "创建账户并继续" })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
  await page.getByLabel("邮箱").fill(uniqueEmail("english-reader"));
  await page.getByLabel("密码").fill("browser-reader-password");
  await page.getByRole("button", { name: "创建账户并继续" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/articles/${slug}$`));
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});
