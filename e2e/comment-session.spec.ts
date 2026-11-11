import { expect, test } from "@playwright/test";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { publishWork } from "./support/works.ts";

test("anonymous articles skip session probes and signed-in readers can create and edit comments", async ({ page, request }) => {
  const { slug } = await publishWork(request, `评论身份 ${Date.now().toString(36)}`, ["一篇可供评论的文章。"]);
  const path = `/articles/${slug}`;
  let probes = 0;
  page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/authoring/session") probes++; });
  await page.goto(path);
  await expect(page.getByText("请先登录后再发表评论。", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "回应 / Comments" })).toBeVisible();
  // Wait for hydration and all public interaction reads to complete.
  await expect(page.getByRole("button", { name: "收藏", exact: true })).toBeEnabled();
  expect(probes).toBe(0);

  // An expired marker is anonymous; a forged future marker is only a hint and
  // still has to be rejected by the session endpoint, not treated as identity.
  await page.context().addCookies([{ name: "nw_session", value: "1", url: page.url() }]);
  await page.goto(path);
  await expect(page.getByText("请先登录后再发表评论。", { exact: false })).toBeVisible();
  expect(probes).toBe(0);
  await page.context().addCookies([{ name: "nw_session", value: String(Math.floor(Date.now() / 1000) + 3600), url: page.url() }]);
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/authoring/session");
  await page.goto(path);
  expect((await rejected).status()).toBe(401);
  await expect(page.getByText("请先登录后再发表评论。", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
  await page.context().clearCookies({ name: "nw_session" });

  await registerThroughForm(page, uniqueEmail("comment-reader"));
  const before = probes;
  await page.goto(path);
  await expect.poll(() => probes).toBeGreaterThan(before);
  await expect(page.getByText("请先登录后再发表评论。", { exact: false })).toHaveCount(0);
  await page.getByLabel("评论内容").fill("这是一条评论。");
  await page.getByRole("button", { name: "提交评论" }).click();
  await expect(page.getByText("评论已发布。", { exact: true })).toBeVisible();
  await expect(page.getByText("这是一条评论。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("评论内容").first().fill("修改后的评论。");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("修改后的评论。", { exact: true })).toBeVisible();
  await expect(page.locator(".nw-comment-edited").filter({ hasText: "已编辑" })).toBeVisible();
});
