import type { Page } from "@playwright/test";

/**
 * A speech engine that can be driven, for the two journeys that speak.
 *
 * A headless browser has no voices installed, so the real engine answers
 * nothing and the page's half of 朗读 cannot be observed at all. This replaces
 * it with one that records what it was handed and reports back when it is done,
 * which is exactly what the assertions are about: the order of the chunks, the
 * mark that follows them, and what 停止 does. How a real voice sounds is not
 * this project's claim, and this file does not pretend to test it.
 *
 * Installed with `addInitScript`, so it is in place before the page's own
 * scripts ask whether the browser can speak.
 */

type Engine = { spoken: string[]; cancelled: number; paused: boolean };

const state = (page: Page): Promise<Engine> =>
  page.evaluate(() => (window as unknown as { __engine: Engine }).__engine);

/** Each chunk is "spoken" for `endAfterMs`, long enough for the states between chunks to be seen. */
export async function installEngine(page: Page, endAfterMs = 1_200): Promise<void> {
  await page.addInitScript((delay) => {
    const engine: Engine = { spoken: [], cancelled: 0, paused: false };
    (window as unknown as { __engine: Engine }).__engine = engine;
    class FakeUtterance {
      text: string;
      lang = "";
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) { this.text = text; }
    }
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak(utterance: FakeUtterance): void {
          engine.spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), delay);
        },
        cancel(): void { engine.cancelled += 1; },
        pause(): void { engine.paused = true; },
        resume(): void { engine.paused = false; },
      },
    });
  }, endAfterMs);
}

/** Take the engine away, the way a browser that cannot speak would. */
export async function removeEngine(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: undefined });
  });
}

/** Everything handed to the engine, in order. */
export async function spokenTexts(page: Page): Promise<string[]> {
  return (await state(page)).spoken;
}

/** How many times 停止 reached the engine. */
export async function cancellations(page: Page): Promise<number> {
  return (await state(page)).cancelled;
}
