import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { interceptNotifications } from "./support/notification-api.ts";

test("keyboard opening a non-modal notification panel enters it and Escape restores the bell", async ({ page }) => {
  await page.goto("/en");
  const bell = page.getByRole("button", { name: "Notifications", exact: true });
  await bell.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
  await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeFocused({ timeout: 1500 });
  await expect(panel).not.toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(bell).toBeFocused();
  await page.keyboard.press("Enter");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(bell).toBeFocused();
});

test("mobile navigation is modal, cycles both Tab directions and returns to its exact trigger", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en");
  const trigger = page.getByRole("button", { name: "Menu", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("dialog", { name: "Menu", exact: true });
  const close = menu.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeFocused({ timeout: 1500 });
  await expect(menu).toHaveAttribute("aria-modal", "true");
  const last = menu.getByRole("link").last();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await close.click();
  await expect(trigger).toBeFocused();
});

test("non-modal notifications let Tab leave and outside focus wins over focus restoration", async ({ page }) => {
  await page.goto("/en");
  const bell = page.getByRole("button", { name: "Notifications", exact: true });
  const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
  await bell.click();
  await panel.getByRole("link").last().focus();
  await page.keyboard.press("Tab");
  await expect(panel).toBeHidden();
  const activeInside = await page.evaluate(() => document.querySelector("#nw-np")?.contains(document.activeElement));
  expect(activeInside).toBe(false);
  await bell.click();
  const search = page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Search", exact: true });
  await search.focus();
  await expect(panel).toBeHidden();
  await expect(search).toBeFocused();
  await bell.click();
  await page.locator(".nw-fbar > span").click();
  await expect(panel).toBeHidden();
  await expect(bell).toBeFocused();
});

test("modal navigation isolates new background content and restores original styles on a breakpoint change", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en");
  await page.evaluate(() => {
    document.body.style.setProperty("overflow", "auto", "important");
    document.body.style.paddingInlineEnd = "7px";
  });
  const trigger = page.getByRole("button", { name: "Menu", exact: true });
  const menu = page.getByRole("dialog", { name: "Menu", exact: true });
  await trigger.click();
  await expect(page.locator("#smooth-wrapper")).toHaveAttribute("inert", "");
  await page.evaluate(() => {
    const button = document.createElement("button"); button.id = "background-late"; button.textContent = "late background";
    document.body.append(button);
  });
  await expect(page.locator("#background-late")).toHaveAttribute("inert", "");
  await page.locator("#background-late").evaluate(element => (element as HTMLElement).focus());
  await expect(menu.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(menu).toBeHidden();
  await expect(page.locator("#smooth-wrapper")).not.toHaveAttribute("inert");
  await expect(page.locator("#background-late")).not.toHaveAttribute("inert");
  expect(await page.evaluate(() => [document.body.style.overflow, document.body.style.getPropertyPriority("overflow"), document.body.style.paddingInlineEnd])).toEqual(["auto", "important", "7px"]);
  expect(await page.evaluate(() => !!document.activeElement?.closest("[hidden], [inert]"))).toBe(false);
});


test("a native leave confirmation above a mobile menu owns Escape and Cancel returns to the menu item", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerThroughForm(page, uniqueEmail("menu-confirm"), "/write");
  await expect(page.getByLabel("作品正文")).toBeVisible();
  await page.route(url => url.pathname === "/api/authoring/articles", route => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await page.getByLabel("标题").fill("焦点保留");
  await page.getByLabel("作品正文").fill("尚未确认保存的正文。");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  const trigger = page.getByRole("button", { name: "选单", exact: true });
  const menu = page.getByRole("dialog", { name: "选单", exact: true });
  await trigger.click();
  const home = menu.getByRole("link", { name: "首页", exact: true });
  await home.click();
  const confirmation = page.getByRole("dialog", { name: "上次保存尚未确认", exact: true });
  const cancel = confirmation.getByRole("button", { name: "取消", exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirmation.getByRole("button", { name: "仍要离开", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(menu).toBeVisible();
  await expect(home).toBeFocused();
  await expect(page).toHaveURL(/\/write$/);
  await home.click();
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(home).toBeFocused();
  await home.click();
  await confirmation.getByRole("button", { name: "仍要离开", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(menu).toBeHidden();
  await expect(page.locator("main")).toBeFocused();
  await expect(page.locator("#smooth-wrapper")).not.toHaveAttribute("inert");
});

test("history navigation out of an open panel focuses the destination, not a hidden Close button", async ({ page }) => {
  await page.goto("/en/authors");
  await page.locator(".nw-rail").click();
  await expect(page).toHaveURL(/\/en$/);
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/en\/authors$/);
  await expect(page.locator("#nw-np")).toBeHidden();
  await expect(page.locator("main")).toBeFocused({ timeout: 1500 });
});

test("a mobile menu releases isolation before a cached-page snapshot", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.locator("#smooth-wrapper")).toHaveAttribute("inert", "");
  const inert = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    return document.querySelector("#smooth-wrapper")!.hasAttribute("inert");
  });
  expect(inert).toBe(false);
  await expect(page.locator("#nw-menu")).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Menu", exact: true }).getByRole("button", { name: "Close", exact: true })).toBeFocused();
});


test("a pending or removed notification control keeps its semantic row and its natural next Tab stop", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "nw_session", value: String(Math.floor(Date.now() / 1000) + 3600), url: new URL(baseURL!).origin }]);
  await page.route(url => url.pathname === "/api/authoring/session", route => route.fulfill({ json: { data: { id: "focus-notification-reader" } } }));
  const api = await interceptNotifications(page);
  api.items[0]!.payload = JSON.stringify({ type: "article.commented", slug: "focused-notice" });
  await page.goto("/en");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
  const row = panel.locator(".nw-np-row").filter({ has: page.locator('a[href="/en/articles/focused-notice#nw-comments-title"]') });
  const held = api.holdNext("write");
  try {
    await row.getByRole("button", { name: "Mark read", exact: true }).click();
    await held.started;
    await expect(row).toBeFocused({ timeout: 1500 });
    held.release();
    await held.finished;
    await expect(row.getByRole("button", { name: "Mark read", exact: true })).toHaveCount(0);
    await expect(row).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(row.getByRole("link", { name: "View", exact: true })).toBeFocused();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /^Notifications/ })).toBeFocused();
  } finally { held.release(); }
});

test("returning to the non-modal bell trigger never traps a subsequent reverse Tab", async ({ page }) => {
  await page.goto("/en");
  const bell = page.getByRole("button", { name: "Notifications", exact: true });
  const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
  await bell.click();
  await bell.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Search", exact: true })).toBeFocused();
});

test("closing a modal menu preserves a later scroll owner's CSS priority", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en");
  await page.evaluate(() => document.body.style.setProperty("overflow", "auto", "important"));
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.evaluate(() => document.body.style.setProperty("overflow", "hidden", "important"));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Menu", exact: true })).toBeHidden();
  expect(await page.evaluate(() => [document.body.style.overflow, document.body.style.getPropertyPriority("overflow")])).toEqual(["hidden", "important"]);
});
