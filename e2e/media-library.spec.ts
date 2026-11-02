import { expect, test } from "@playwright/test";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";

/**
 * The media library, end to end (ADR 0022).
 *
 * What this file can see that the cheaper layers cannot: that the page exists at
 * the URL the desk links to, that a visitor who is not signed in is sent to sign
 * in *and pointed back*, and that a deployment without object storage says so
 * instead of showing an empty library.
 *
 * That last one is the journey worth having. The API tests prove the 503 and the
 * HTTP tests prove the proxy forwards it — but neither can see the difference
 * between "you have no images" and "this deployment cannot accept images", and
 * the second one sends an author looking for uploads that were never stored.
 *
 * The journeys that would need object storage — an image appearing in the grid,
 * an orphan badge on one nothing uses, 删除 taking it away — are not here,
 * because this suite runs without an S3-compatible bucket. They are the part
 * that stays manual until a deployment has one.
 */

test("an anonymous visitor is sent to sign in, and pointed back afterwards", async ({ page }) => {
  await page.goto("/write/media");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fwrite%2Fmedia/);
  await expect(page.getByLabel("邮箱")).toBeVisible();
});

test("a signed-in author is told when image storage is not configured, not shown an empty library", async ({ page }) => {
  const email = uniqueEmail("media");
  await registerThroughForm(page, email, "/write/media");
  // The heading renders before the API has answered, so the assertion that
  // matters is the alert: it is the page saying what is actually wrong.
  await expect(page.getByRole("alert")).toContainText("这个部署没有配置图片存储");
  await expect(page.getByRole("link", { name: "回到写作台" })).toBeVisible();
  // An unconfigured deployment must not claim an empty library: "you have no
  // images" and "this deployment cannot accept images" are different sentences,
  // and only one of them sends an author looking for uploads that were never
  // stored.
  await expect(page.getByText("还没有上传过图片")).toHaveCount(0);
});

test("the writing desk links to the library", async ({ page }) => {
  const email = uniqueEmail("media-desk");
  await registerThroughForm(page, email, "/write");
  await page.getByRole("link", { name: "媒体库" }).click();
  await expect(page).toHaveURL(/\/write\/media$/);
  await expect(page.getByRole("heading", { name: /媒体库/ })).toBeVisible();
});
