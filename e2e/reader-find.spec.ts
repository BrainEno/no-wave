import { expect, type Page } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { publishWork } from "./support/works.ts";
import { holdAnimationFrames } from "./support/animation-frame-gate.ts";

let slug = "";
test.beforeAll(async ({ request }) => {
  const paragraphs = [
    "River Ｒｉｖｅｒ river; literal a+b and [x].",
    "The cafe\u0301 by the river has a fox 🦊.",
    ...Array.from(
      { length: 30 },
      (_, index) =>
        `Section ${index + 1}. ${index === 20 ? "Unique destination in this paragraph. " : ""}${"Words and punctuation stay in the original article. ".repeat(8)}`,
    ),
  ];
  slug = (
    await publishWork(
      request,
      `Find reader ${Date.now().toString(36)}`,
      paragraphs,
      "en",
    )
  ).slug;
});
const panel = (page: Page) => page.locator(".nw-reader-find");
const form = (page: Page) =>
  page.getByRole("search", { name: "Find in this work", exact: true });
async function openSearch(page: Page, query: string) {
  await page.goto(`/en/articles/${slug}`);
  await panel(page)
    .getByRole("button", { name: "Find in this work", exact: true })
    .click();
  const input = form(page).getByRole("searchbox", {
    name: "Words in this work",
    exact: true,
  });
  await expect(input).toBeFocused();
  await expect(input).toBeInViewport();
  await input.fill(query);
  return input;
}

test("literal Unicode/case/width matches are local and highlights never rewrite the article", async ({
  page,
}) => {
  const input = await openSearch(page, "river");
  const html = await page.locator("#nw-article").innerHTML();
  await expect(form(page)).toContainText("4 matches in this work");
  expect(await page.locator("#nw-article").innerHTML()).toBe(html);
  await form(page)
    .getByRole("checkbox", { name: "Match case", exact: true })
    .check();
  await expect(form(page)).toContainText("2 matches in this work");
  await form(page)
    .getByRole("checkbox", { name: "Match case", exact: true })
    .uncheck();
  await form(page)
    .getByRole("checkbox", {
      name: "Treat full-width and half-width alike",
      exact: true,
    })
    .uncheck();
  await expect(form(page)).toContainText("3 matches in this work");
  await input.fill("a+b");
  await expect(form(page)).toContainText("1 matches in this work");
  const outgoing: string[] = [];
  page.on("request", (request) =>
    outgoing.push(request.url() + (request.postData() ?? "")),
  );
  await input.fill("private-find-sentinel-9031");
  await expect(form(page)).toContainText("No matching words");
  expect(outgoing.join("\n")).not.toContain("private-find-sentinel-9031");
  await expect(page).toHaveURL(new RegExp(`/en/articles/${slug}$`));
});

test("F3 and Shift+F3 continue real keyboard navigation after focus enters the matched paragraph", async ({
  page,
}) => {
  const input = await openSearch(page, "river");
  await expect(form(page)).toContainText("4 matches in this work");
  await input.press("Enter");
  await expect(panel(page)).toContainText("Match 1 of 4");
  await expect(
    page.locator("#nw-article > [data-block]").first(),
  ).toBeFocused();
  await page.keyboard.press("F3");
  await expect(panel(page)).toContainText("Match 2 of 4");
  await page.keyboard.press("Shift+F3");
  await expect(panel(page)).toContainText("Match 1 of 4");
  await page.keyboard.press("Escape");
  await expect(form(page)).toHaveCount(0);
  await expect(
    page.locator("#nw-article > [data-block]").first(),
  ).toBeFocused();
});

test("IME composition does not let Escape close the form or Enter locate a premature query", async ({
  page,
}) => {
  const input = await openSearch(page, "river");
  await expect(form(page)).toContainText("4 matches in this work");
  await input.dispatchEvent("keydown", {
    key: "Escape",
    isComposing: true,
    bubbles: true,
  });
  await expect(form(page)).toBeVisible();
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(form(page)).toHaveCount(0);
  await expect(
    panel(page).getByRole("button", { name: "Find in this work", exact: true }),
  ).toBeFocused();
});

test("nested list item boundaries cannot fuse into invented words, but spaced phrases remain locatable", async ({
  page,
}) => {
  const input = await openSearch(page, "boundarypiece");
  await page.locator("#nw-article").evaluate((article) => {
    const list = document.createElement("ul");
    list.dataset.block = "list-boundary-witness";
    for (const text of ["boundary", "piece"]) {
      const item = document.createElement("li");
      item.textContent = text;
      list.append(item);
    }
    article.prepend(list);
  });
  await expect(form(page)).toContainText("No matching words");
  await input.fill("boundary piece");
  await expect(form(page)).toContainText("1 matches in this work");
  await input.press("Enter");
  await expect(
    page.locator("[data-block='list-boundary-witness']"),
  ).toBeFocused();
  await expect(panel(page)).toContainText("Match 1 of 1");
});

test("without Custom Highlight support the original body and location controls still work", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Highlight", {
      configurable: true,
      value: undefined,
    });
  });
  const input = await openSearch(page, "a+b");
  await expect(form(page)).toContainText("1 matches in this work");
  await expect(form(page)).toContainText("cannot paint search highlights");
  await input.press("Enter");
  await expect(
    page.locator("#nw-article > [data-block]").first(),
  ).toBeFocused();
  await expect(page.locator("#nw-article mark")).toHaveCount(0);
});

test("a new Tab intent between submit and paint cancels the pending location without stealing focus", async ({
  page,
}) => {
  await openSearch(page, "river");
  await expect(form(page)).toContainText("4 matches in this work");
  const next = form(page).getByRole("button", {
    name: "Next match",
    exact: true,
  });
  await next.focus();
  const release = await holdAnimationFrames(page);
  try {
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
  } finally {
    await release();
  }
  await expect(
    form(page).getByRole("button", { name: "Clear search", exact: true }),
  ).toBeFocused();
  await expect(panel(page)).toContainText(
    "Location cancelled because you moved elsewhere.",
  );
});

test("clear and navigation release only this find session's highlights", async ({
  page,
}) => {
  const input = await openSearch(page, "river");
  await expect(form(page)).toContainText("4 matches in this work");
  await page.evaluate(() => {
    CSS.highlights.set("reading-test-other", new Highlight());
  });
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.has("nw-reader-find")))
    .toBe(true);
  await form(page)
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.has("nw-reader-find")))
    .toBe(false);
  expect(
    await page.evaluate(() => CSS.highlights.has("reading-test-other")),
  ).toBe(true);
  await input.fill("river");
  await expect(form(page)).toContainText("4 matches in this work");
  await page
    .getByRole("link", { name: "Open reading list", exact: false })
    .click();
  await expect(page).toHaveURL(/\/en\/reading-list$/);
  await expect(
    page.getByRole("heading", { name: "Reading list", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => [
        CSS.highlights.has("nw-reader-find"),
        CSS.highlights.has("nw-reader-find-current"),
        CSS.highlights.has("reading-test-other"),
      ]),
    )
    .toEqual([false, false, true]);
});

test("normal-motion reading uses the transformed scroll owner for a distant match", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const input = await openSearch(page, "Unique destination");
  await expect(page.locator("html")).toHaveClass(/nw-smooth/);
  await expect(form(page)).toContainText("1 matches in this work");
  await input.press("Enter");
  const target = page
    .locator("#nw-article > [data-block]")
    .filter({ hasText: "Unique destination" });
  await expect(target).toBeFocused();
  await expect
    .poll(() =>
      target.evaluate((element) =>
        Math.round(element.getBoundingClientRect().top),
      ),
    )
    .toBeGreaterThanOrEqual(0);
  await expect
    .poll(() =>
      target.evaluate((element) =>
        Math.round(element.getBoundingClientRect().top),
      ),
    )
    .toBeLessThan(400);
  await expect
    .poll(() =>
      page.locator("#smooth-wrapper").evaluate((element) => element.scrollTop),
    )
    .toBe(0);
});

test("missing grapheme segmentation leaves the article and other controls usable instead of crashing hydration", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      value: undefined,
    });
  });
  const input = await openSearch(page, "river");
  await expect(form(page)).toContainText("Use the browser’s Find command");
  await expect(
    form(page).getByRole("button", { name: "Next match", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#nw-article")).toContainText(
    "River Ｒｉｖｅｒ river",
  );
  await input.press("Escape");
  await expect(
    page.getByRole("button", { name: "Add to reading list", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});
