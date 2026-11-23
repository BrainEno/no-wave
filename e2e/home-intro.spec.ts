import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";

/**
 * The home intro under normal motion: the counted curtain, then the hero.
 *
 * The harness default is reduced motion, which skips the curtain entirely, so
 * this file opts back in. A fresh context has an empty sessionStorage, which is
 * what makes the curtain play at all ("nw-loaded" marks it as seen).
 */
test.use({ reducedMotion: "no-preference" });

test("the intro curtain covers the viewport, shows its counter on screen and then leaves", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  const loader = page.locator("[data-loader]");
  await expect(loader).toBeAttached();

  const geometry = await loader.evaluate((element) => {
    const counter = element.querySelector(".nw-cnt")!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    // Whatever is at the centre of the screen must be the curtain itself, not
    // the rail, the pill or the page: that is what "covers" means.
    const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return {
      insideSmoothContent: element.closest("#smooth-content") !== null,
      height: box.height,
      viewport: window.innerHeight,
      counterTop: counter.top,
      counterBottom: counter.bottom,
      centreIsCurtain: top !== null && element.contains(top),
    };
  });
  // A fixed layer inside the transformed ScrollSmoother content is positioned
  // against the whole page: it grows to the page height and its centred counter
  // ends up below the fold.
  expect(geometry.insideSmoothContent).toBe(false);
  expect(geometry.height).toBe(geometry.viewport);
  expect(geometry.counterTop).toBeGreaterThanOrEqual(0);
  expect(geometry.counterBottom).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.centreIsCurtain).toBe(true);

  // Six even dark columns, as the original design had them: no accent column.
  const colours = await page.locator(".nw-load .nw-col").evaluateAll((columns) => columns.map((column) => getComputedStyle(column).backgroundColor));
  expect(colours).toHaveLength(6);
  expect(new Set(colours).size).toBe(1);

  await expect(loader).toHaveCount(0, { timeout: 10_000 });
  expect(pageErrors, `the intro must not throw:\n${pageErrors.join("\n")}`).toEqual([]);
});
