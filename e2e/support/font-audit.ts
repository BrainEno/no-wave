import { expect, type Page } from "@playwright/test";

export type FontTransfer = { url: string; transferSize: number; bodySize: number };
export type FontFaceState = { family: string; style: string; weight: string; range: string; status: string };
export type FontAudit = { resources: FontTransfer[]; faces: FontFaceState[]; transferBytes: number; bodyBytes: number };
export type ClsAudit = { supported: boolean; max: number; shifts: { at: number; value: number }[] };

declare global {
  interface Window { readFontCls?: () => ClsAudit }
}

/** Observe before the first paint. CLS is the maximum session window, not a sum. */
export async function installFontClsProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Start the first window at its first shift, even before the first second.
    let start = 0, last = -Infinity, session = 0, max = 0;
    const shifts: { at: number; value: number }[] = [];
    const supported = PerformanceObserver.supportedEntryTypes.includes("layout-shift");
    window.readFontCls = () => ({ supported, max, shifts: [...shifts] });
    if (!supported) return;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (entry.hadRecentInput) continue;
        if (entry.startTime - last >= 1000 || entry.startTime - start >= 5000) {
          start = entry.startTime;
          session = 0;
        }
        session += entry.value;
        last = entry.startTime;
        max = Math.max(max, session);
        shifts.push({ at: entry.startTime, value: entry.value });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

/** Wait for actual font completion, never silently time out into a passing fallback. */
export async function settleFonts(page: Page): Promise<void> {
  await expect(page.locator("main")).toBeVisible();
  // Hydrated comments introduce glyphs after SSR. Do not wait for all network
  // traffic: the view beacon may intentionally stay in flight and is unrelated
  // to font readiness. Wait for the actual UI, then a font-only quiet window.
  if (await page.locator(".nw-comment-section").count()) {
    await expect(page.locator(".nw-comment-section > [role=status]")).toHaveCount(0);
    await expect(page.locator(".nw-comment-section > [role=alert]")).toHaveCount(0);
    await expect(page.getByLabel("评论内容", { exact: true })).toHaveAttribute("contenteditable", "true");
  }
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    let idle = 0;
    const fonts = document.fonts;
    const cleanup = () => {
      window.clearTimeout(idle);
      window.clearTimeout(deadline);
      for (const event of ["loading", "loadingdone", "loadingerror"]) fonts.removeEventListener(event, changed);
    };
    const changed = () => {
      window.clearTimeout(idle);
      if (fonts.status === "loaded") idle = window.setTimeout(() => { cleanup(); resolve(); }, 200);
    };
    const deadline = window.setTimeout(() => { cleanup(); reject(new Error("Fonts did not settle within 15 seconds")); }, 15_000);
    for (const event of ["loading", "loadingdone", "loadingerror"]) fonts.addEventListener(event, changed);
    void fonts.ready.then(changed);
  }));
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loaded");
  // GSAP advances on its own lag-smoothed clock: software GL can take much
  // longer than the nominal animation duration. Keep ordinary motion enabled
  // and require the actual curtain AND letter entrance to finish, rather than
  // shortening observation to a fixed sleep. This separate bounded animation
  // window does not relax the 15-second font-loading deadline above.
  await page.waitForFunction(() => {
    if (document.querySelector(".nw-load")) return false;
    return [...document.querySelectorAll("[data-intro] i")].every((element) => {
      const transform = getComputedStyle(element).transform;
      return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity;
    });
  }, undefined, { timeout: 60_000 });
  // Commit fonts/layout to a paint before reading resource timings and boxes.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Same-origin Resource Timing includes headers; WOFF2 is already compressed. */
export async function readFontAudit(page: Page): Promise<FontAudit> {
  return page.evaluate(() => {
    const resources = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => new URL(entry.name).pathname.endsWith(".woff2"))
      .map((entry) => ({ url: entry.name, transferSize: entry.transferSize, bodySize: entry.encodedBodySize }));
    const faces: FontFaceState[] = [];
    document.fonts.forEach((face) => {
      if (face.status !== "unloaded") faces.push({ family: face.family, style: face.style, weight: face.weight,
        range: face.unicodeRange, status: face.status });
    });
    return { resources, faces, transferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
      bodyBytes: resources.reduce((sum, entry) => sum + entry.bodySize, 0) };
  });
}

export function assertFirstPartyFontAudit(audit: FontAudit, origin: string): void {
  expect(audit.resources.length, "at least one real network font, not an empty/fallback-only pass").toBeGreaterThan(0);
  for (const resource of audit.resources) {
    expect(new URL(resource.url).origin, resource.url).toBe(origin);
    expect(new URL(resource.url).pathname).toMatch(/^\/assets\/.+-[A-Za-z0-9_-]+\.woff2$/);
    expect(resource.bodySize, `${resource.url}: cold response bytes`).toBeGreaterThan(0);
    expect(resource.transferSize, `${resource.url}: transfer bytes include body`).toBeGreaterThanOrEqual(resource.bodySize);
  }
  expect(audit.faces.length).toBeGreaterThan(0);
  expect(audit.faces.filter((face) => face.status !== "loaded"), "no failed or pending font faces").toEqual([]);
}

/** CDP proves the browser painted the webfont; fonts.check alone accepts fallback. */
export async function assertCustomFont(page: Page, selector: string, expectedFamily: string): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    expect(nodeId, `font audit target ${selector}`).toBeGreaterThan(0);
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.some((font) => font.isCustomFont && font.glyphCount > 0 && font.familyName.startsWith(expectedFamily)),
      `${selector}: expected ${expectedFamily}, painted ${JSON.stringify(fonts)}`).toBe(true);
  } finally { await session.detach(); }
}

export async function fontLayout(page: Page, selectors: readonly string[]) {
  return page.evaluate((targets) => targets.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing typography target: ${selector}`);
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return { selector, text: element.textContent, family: style.fontFamily, weight: style.fontWeight,
      style: style.fontStyle, lineHeight: style.lineHeight, x: round(box.x), y: round(box.y),
      width: round(box.width), height: round(box.height), scrollHeight: element.scrollHeight };
  }), [...selectors]);
}
