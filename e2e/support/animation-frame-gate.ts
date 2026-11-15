import type { Page } from "@playwright/test";

/** Hold the next paint, not promises/network/React commits, to exercise intent races. */
export async function holdAnimationFrames(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const view = window as Window & { releaseTestFrames?: () => void };
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const queued = new Map<number, FrameRequestCallback>();
    let sequence = -1;
    window.requestAnimationFrame = callback => { const id = sequence--; queued.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { if (!queued.delete(id)) cancel(id); };
    view.releaseTestFrames = () => {
      window.requestAnimationFrame = request;
      window.cancelAnimationFrame = cancel;
      delete view.releaseTestFrames;
      for (const callback of queued.values()) request(callback);
      queued.clear();
    };
  });
  return async () => {
    if (page.isClosed()) return;
    await page.evaluate(() => (window as Window & { releaseTestFrames?: () => void }).releaseTestFrames?.());
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
}
