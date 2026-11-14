import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { test as base } from "./support/csp-fixture.ts";
import {
  assertCustomFont,
  assertFirstPartyFontAudit,
  fontLayout,
  installFontClsProbe,
  readFontAudit,
  settleFonts,
} from "./support/font-audit.ts";
import { publishWork } from "./support/works.ts";
import { startFontStack, type FontStack } from "./support/font-stack.ts";

const test = base.extend<{}, { fontStack: FontStack }>({
  fontStack: [async ({}, runWithStack) => {
    const stack = await startFontStack();
    try { await runWithStack(stack); }
    finally { await stack.close(); }
  }, { scope: "worker", timeout: 60_000 }],
});

const ARTICLE_TITLE = "纸上无浪：城市与夜色";
const ARTICLE_PARAGRAPHS = [
  "夜色落在窗前，城市的声音渐渐远去。我们在纸上留下句子，也为下一位读者留出一处安静的位置。",
  "阅读不必急着抵达结尾。文字在时间里相遇，让每一次停顿都有自己的重量。文学来自日常，也走向更宽广的世界。",
  "No Wave is a place for careful reading. Words, memory, and imagination meet here — one page at a time.",
];

async function coldContext(browser: Browser, baseURL: string, motion: "reduce" | "no-preference" = "reduce"): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, colorScheme: "light",
    reducedMotion: motion, serviceWorkers: "block" });
}

function collectThirdPartyRequests(page: Page, origin: string): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) requests.push(url.href);
  });
  return requests;
}

async function assertNoExternalFontLinks(page: Page): Promise<void> {
  const links = await page.locator('link[rel="stylesheet"], link[rel="preconnect"], link[rel="dns-prefetch"]').evaluateAll((elements) =>
    elements.map((element) => (element as HTMLLinkElement).href));
  expect(links.length).toBeGreaterThan(0);
  for (const href of links) {
    expect(new URL(href).origin).toBe(new URL(page.url()).origin);
    expect(href).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  }
}

test("cold sign-in loads first-party fonts below 300 KB, including after switching to registration", async ({ browser, fontStack }, testInfo) => {
  const baseURL = fontStack.webBaseUrl;
  expect(baseURL).toBeTruthy();
  const context = await coldContext(browser, baseURL);
  try {
    const page = await context.newPage();
    const external = collectThirdPartyRequests(page, new URL(baseURL).origin);
    await page.goto("/sign-in", { waitUntil: "load" });
    await settleFonts(page);
    await assertNoExternalFontLinks(page);
    const login = await readFontAudit(page);
    assertFirstPartyFontAudit(login, new URL(baseURL).origin);
    expect(login.transferBytes).toBeLessThan(300_000);
    await assertCustomFont(page, "#nw-auth-title .nw-zh", "Noto Serif SC");
    await assertCustomFont(page, ".nw-auth-form label", "Noto Sans SC");
    await page.getByRole("button", { name: "没有账户？创建账户", exact: true }).click();
    await expect(page.getByRole("heading", { name: "创建账户 Join" })).toBeVisible();
    await settleFonts(page);
    const register = await readFontAudit(page);
    assertFirstPartyFontAudit(register, new URL(baseURL).origin);
    expect(register.transferBytes).toBeLessThan(300_000);
    expect(external).toEqual([]);
    await testInfo.attach("sign-in-font-transfer.json", { body: JSON.stringify({ login, register }, null, 2), contentType: "application/json" });
  } finally { await context.close(); }
});

test("a representative Chinese and English article loads fonts below 600 KB and caches hashed WOFF2", async ({ browser, request, fontStack }, testInfo) => {
  const baseURL = fontStack.webBaseUrl;
  const { slug } = await publishWork(request, ARTICLE_TITLE, ARTICLE_PARAGRAPHS, undefined, fontStack.apiBaseUrl);
  const context = await coldContext(browser, baseURL);
  try {
    const page = await context.newPage();
    const external = collectThirdPartyRequests(page, new URL(baseURL).origin);
    await page.goto(`/articles/${slug}`, { waitUntil: "load" });
    await expect(page.getByRole("heading", { name: ARTICLE_TITLE, exact: true })).toBeVisible();
    await settleFonts(page);
    const audit = await readFontAudit(page);
    await testInfo.attach("article-font-transfer.json", { body: JSON.stringify(audit, null, 2), contentType: "application/json" });
    assertFirstPartyFontAudit(audit, new URL(baseURL).origin);
    expect(audit.transferBytes).toBeLessThan(600_000);
    await assertNoExternalFontLinks(page);
    await assertCustomFont(page, ".nw-rh h1", "Noto Serif SC");
    await assertCustomFont(page, "#nw-article p", "Noto Serif SC");
    const font = audit.resources[0]!;
    const response = await context.request.get(font.url);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("font/woff2");
    expect(response.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(Number(response.headers()["content-length"])).toBe((await response.body()).length);
    const head = await context.request.head(font.url);
    expect(head.status()).toBe(200);
    expect(head.headers()["content-type"]).toBe("font/woff2");
    expect(head.headers()["cache-control"]).toBe(response.headers()["cache-control"]);
    expect(Number(head.headers()["content-length"])).toBe(Number(response.headers()["content-length"]));
    expect((await head.body()).length).toBe(0);
    expect(external).toEqual([]);
  } finally { await context.close(); }
});

test("all four original families and the real Instrument Serif italic remain available", async ({ page, fontStack }) => {
  await page.goto(fontStack.webBaseUrl + "/", { waitUntil: "load" });
  await settleFonts(page);
  // These are explicit coverage probes, separate from the transfer-budget paths.
  // Checking the CSS family alone would pass when every font URL answered 404.
  const probes = await page.evaluate(async () => {
    const checks = [
      { family: "Instrument Serif", font: '400 32px "Instrument Serif"', text: "No Wave" },
      { family: "Instrument Serif", font: 'italic 400 32px "Instrument Serif"', text: "No Wave" },
      { family: "Inter Tight", font: '700 32px "Inter Tight"', text: "No Wave 2026" },
      { family: "Noto Serif SC", font: '600 32px "Noto Serif SC"', text: "无浪潮龘" },
      { family: "Noto Sans SC", font: '500 32px "Noto Sans SC"', text: "无浪潮龘" },
    ];
    return Promise.all(checks.map(async (check) => {
      const faces = await document.fonts.load(check.font, check.text);
      return { ...check, faces: faces.map((face) => ({ family: face.family, style: face.style, status: face.status })) };
    }));
  });
  for (const probe of probes) {
    expect(probe.faces.length, probe.font).toBeGreaterThan(0);
    expect(probe.faces.every((face) => face.family.replaceAll('"', "") === probe.family && face.status === "loaded")).toBe(true);
    if (probe.font.startsWith("italic")) expect(probe.faces.every((face) => face.style === "italic")).toBe(true);
  }
  await assertCustomFont(page, ".nw-cn", "Noto Serif SC");
  await assertCustomFont(page, ".nw-wm .nw-ss", "Inter Tight");
  await assertCustomFont(page, ".nw-wm .nw-it", "Instrument Serif");
});

// Each cold load gets its own ordinary deadline and retained measurement.
// All five are required: retries must not turn a bad performance sample green.
test.describe("five consecutive cold desktop home loads", () => {
  test.describe.configure({ retries: 0 });
  for (const run of [1, 2, 3, 4, 5]) {
    test(`cold desktop home ${run}/5 keeps CLS below 0.05 with ordinary motion`, async ({ browser, fontStack }, testInfo) => {
      const baseURL = fontStack.webBaseUrl;
      const context = await coldContext(browser, baseURL, "no-preference");
      try {
        const page = await context.newPage();
        await installFontClsProbe(page);
        await page.goto("/", { waitUntil: "load" });
        await settleFonts(page);
        // A defined observation window is the measurement itself, not a sleep to
        // paper over readiness. Include the end of the real hero entrance motion.
        await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 1500)));
        const cls = await page.evaluate(() => {
          if (!window.readFontCls) throw new Error("CLS probe was not installed before navigation");
          return window.readFontCls();
        });
        const fonts = await readFontAudit(page);
        await testInfo.attach(`home-cold-load-${run}-cls.json`, {
          body: JSON.stringify({ run, cls, transferBytes: fonts.transferBytes }, null, 2), contentType: "application/json",
        });
        assertFirstPartyFontAudit(fonts, new URL(baseURL).origin);
        expect(cls.supported).toBe(true);
        expect(cls.max, `desktop home cold run ${run}: ${JSON.stringify(cls.shifts)}`).toBeLessThan(0.05);
      } finally { await context.close(); }
    });
  }
});

test("blocking every third-party request leaves home, sign-in and article typography unchanged", async ({ browser, request, fontStack }, testInfo) => {
  const baseURL = fontStack.webBaseUrl;
  const { slug } = await publishWork(request, ARTICLE_TITLE, ARTICLE_PARAGRAPHS, undefined, fontStack.apiBaseUrl);
  const targets = [
    { path: "/", selectors: [".nw-cn", ".nw-wm", ".nw-pill"] },
    { path: "/sign-in", selectors: ["#nw-auth-title", ".nw-ep", ".nw-auth-form", ".nw-pill"] },
    { path: `/articles/${slug}`, selectors: [".nw-rh h1", "#nw-article p", ".nw-pill"] },
  ];
  const comparisons = [];
  for (const target of targets) {
    const readings = [];
    for (const blocked of [false, true]) {
      const context = await coldContext(browser, baseURL);
      try {
        const page = await context.newPage();
        const external = collectThirdPartyRequests(page, new URL(baseURL).origin);
        if (blocked) await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          return ["http:", "https:"].includes(url.protocol) && url.origin !== new URL(baseURL).origin ? route.abort("blockedbyclient") : route.continue();
        });
        await page.goto(target.path, { waitUntil: "load" });
        await settleFonts(page);
        await assertNoExternalFontLinks(page);
        const fonts = await readFontAudit(page);
        assertFirstPartyFontAudit(fonts, new URL(baseURL).origin);
        expect(external, `${target.path}: no third-party dependencies, not even blocked attempts`).toEqual([]);
        readings.push({ blocked, layout: await fontLayout(page, target.selectors),
          faces: fonts.faces.map((face) => `${face.family}:${face.style}:${face.weight}:${face.range}`).sort(),
          resources: fonts.resources.map((font) => new URL(font.url).pathname).sort() });
      } finally { await context.close(); }
    }
    expect(readings[1]!.layout, `${target.path}: identical text, family, line boxes and dimensions`).toEqual(readings[0]!.layout);
    expect(readings[1]!.faces, `${target.path}: identical actually loaded font faces`).toEqual(readings[0]!.faces);
    expect(readings[1]!.resources, `${target.path}: identical first-party subsets`).toEqual(readings[0]!.resources);
    comparisons.push({ path: target.path, readings });
  }
  await testInfo.attach("third-party-blocked-typography.json", { body: JSON.stringify(comparisons, null, 2), contentType: "application/json" });
});


test("delayed first-party fonts keep desktop and mobile wordmark slots stable without hiding text", async ({ browser, fontStack }, testInfo) => {
  const baseURL = fontStack.webBaseUrl;
  const measurements = [];
  for (const width of [1280, 390]) {
    const context = await coldContext(browser, baseURL);
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 720 });
      await installFontClsProbe(page);
      await context.route("**/*.woff2", async (route) => { await held; await route.continue(); });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".nw-wm")).toBeVisible();
      const selectors = [".nw-brand", ".nw-cn", ".nw-wm"];
      const before = await fontLayout(page, selectors);
      expect(await page.evaluate(() => document.fonts.status)).toBe("loading");
      release();
      await settleFonts(page);
      const after = await fontLayout(page, selectors);
      for (let index = 0; index < before.length; index++) {
        expect(after[index]!.width).toBeCloseTo(before[index]!.width, 1);
        expect(after[index]!.height).toBeCloseTo(before[index]!.height, 1);
        expect(after[index]!.x).toBeCloseTo(before[index]!.x, 1);
        expect(after[index]!.y).toBeCloseTo(before[index]!.y, 1);
      }
      const cls = await page.evaluate(() => window.readFontCls!());
      expect(cls.supported).toBe(true);
      expect(cls.max, `slow font swap at ${width}px`).toBeLessThan(0.05);
      measurements.push({ width, before, after, cls });
    } finally { release(); await context.close(); }
  }
  await testInfo.attach("delayed-font-wordmark.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
});
