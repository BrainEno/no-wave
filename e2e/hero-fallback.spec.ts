import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";

/**
 * A browser without WebGL used to have its React-owned hero canvas removed by
 * the component itself. Navigating away then made React call removeChild() on a
 * node that was already gone. This drives a real client-side route change with
 * WebGL disabled and asserts that the page survives it.
 *
 * Without WebGL the smear now falls back to Canvas 2D (a fresh element, keyed
 * by mode, because a canvas that was asked for WebGL cannot hand out a 2D
 * context); only when 2D is refused as well is the canvas gone and the static
 * cover all that remains. Both steps unmount a React-owned node, so both are
 * driven through a client-side navigation.
 */
function refuseContexts(types: readonly string[]) {
  return `
      const refused = new Set(${JSON.stringify(types)});
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (refused.has(type)) return null;
        return original.call(this, type, ...args);
      };
    `;
}

const webgl = ["webgl", "experimental-webgl", "webgl2"] as const;

for (const [name, refused, canvases] of [
  ["a WebGL failure falls back to Canvas 2D and survives navigation", webgl, 1],
  ["a WebGL and 2D failure falls back to the static cover and survives navigation", [...webgl, "2d"], 0],
] as const) test(name, async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.addInitScript({ content: refuseContexts(refused) });

  await page.goto("/");
  await expect(page.locator("[data-hero] img.nw-hero-bg")).toBeVisible();
  await expect(page.locator("[data-hero] canvas")).toHaveCount(canvases);
  if (canvases) await expect(page.locator("[data-hero] canvas")).toHaveAttribute("data-mode", "2d");

  await page.locator('.nw-pill a[href="/en"]').first().click();
  await expect(page).toHaveURL(/\/en$/);

  expect(pageErrors, `React navigation must not throw:\n${pageErrors.join("\n")}`).toEqual([]);
  expect(
    consoleErrors.filter((text) => /removeChild|NotFoundError/i.test(text)),
    `no removeChild error should reach the console:\n${consoleErrors.join("\n")}`,
  ).toEqual([]);
});
