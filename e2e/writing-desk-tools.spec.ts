import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { DEEP_WRITING_TOOLS } from "../packages/web-ui/src/lib/writing-tool-pages.ts";

/**
 * The proofreading pages are named in the desk's own navigation.
 *
 * Before, the only way to them was the end of the collapsed tool panel, which
 * exists only under a selected draft — a new author with no works could not see
 * them at all. This is the journey the cheaper layers cannot see: a brand-new
 * account opens the desk, finds 写作工具 in the header, and every entry opens
 * the real page in a new tab, leaving the editor where it was.
 */
test("a new author finds every writing tool in the desk header, and each opens in a new tab", async ({ page, context }) => {
  await registerThroughForm(page, uniqueEmail("desk-tools"), "/write");
  const nav = page.getByRole("navigation", { name: "写作台去处" });
  const tools = nav.locator("details.nw-desk-tools");
  await expect(tools.getByText("写作工具", { exact: true })).toBeVisible();
  // Closed by default: the links are not on screen until asked for.
  await expect(tools.getByRole("link", { name: /段落审阅/ })).toBeHidden();

  await tools.getByText("写作工具", { exact: true }).click();
  for (const tool of DEEP_WRITING_TOOLS) {
    const link = tools.getByRole("link", { name: new RegExp(`^${tool.label} ↗`) });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", tool.href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  // The open card stays inside the viewport rather than spilling off the right edge.
  const card = await tools.locator(".nw-desk-menu").boundingBox();
  const viewport = page.viewportSize();
  expect(card && viewport && card.x >= 0 && card.x + card.width <= viewport.width).toBe(true);

  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    tools.getByRole("link", { name: /^加密备份 ↗/ }).click(),
  ]);
  await opened.waitForLoadState("load");
  await expect(opened).toHaveURL(/\/write\/vault$/);
  await expect(opened.getByRole("heading", { name: "本机文稿加密备份", exact: true })).toBeVisible();
  // The desk tab did not navigate away.
  await expect(page).toHaveURL(/\/write$/);
  await opened.close();
});

test("on a phone the tools card opens inside the screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await registerThroughForm(page, uniqueEmail("desk-tools-mobile"), "/write");
    const tools = page.getByRole("navigation", { name: "写作台去处" }).locator("details.nw-desk-tools");
    await tools.getByText("写作工具", { exact: true }).click();
    await expect(tools.getByRole("link", { name: /^三方合并 ↗/ })).toBeVisible();
    const card = await tools.locator(".nw-desk-menu").boundingBox();
    expect(card).not.toBeNull();
    expect(card!.x).toBeGreaterThanOrEqual(0);
    expect(card!.x + card!.width).toBeLessThanOrEqual(375);
  } finally {
    await context.close();
  }
});
