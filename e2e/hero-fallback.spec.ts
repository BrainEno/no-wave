import { expect, test } from "@playwright/test";

/**
 * A browser without WebGL used to have its React-owned hero canvas removed by
 * the component itself. Navigating away then made React call removeChild() on a
 * node that was already gone. This drives a real client-side route change with
 * WebGL disabled and asserts that the static cover is what remains.
 */
test("a WebGL failure falls back to the static cover and survives navigation", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.addInitScript({
    content: `
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (type === "webgl" || type === "experimental-webgl" || type === "webgl2") return null;
        return original.call(this, type, ...args);
      };
    `,
  });

  await page.goto("/");
  await expect(page.locator("[data-hero] img.nw-hero-bg")).toBeVisible();
  await expect(page.locator("[data-hero] canvas")).toHaveCount(0);

  await page.locator('.nw-pill a[href="/en"]').first().click();
  await expect(page).toHaveURL(/\/en$/);

  expect(pageErrors, `React navigation must not throw:\n${pageErrors.join("\n")}`).toEqual([]);
  expect(
    consoleErrors.filter((text) => /removeChild|NotFoundError/i.test(text)),
    `no removeChild error should reach the console:\n${consoleErrors.join("\n")}`,
  ).toEqual([]);
});
