/**
 * One voice at a time.
 *
 * Reading aloud is a browser capability (ADR 0020), and the page now asks for it
 * from two places: the control that reads a whole work, and the shelf that reads
 * one marked passage. Both go through here, because a browser has a single
 * speech queue and two readings that do not know about each other would talk
 * over one another — or, worse, one would silently carry on after the other was
 * told to stop, because `cancel()` reports itself as an ended utterance.
 *
 * So: whoever speaks takes the voice, and whoever had it is stopped first. A
 * sequence that has been stopped does not advance, whatever the engine reports.
 *
 * This is browser-only code, reached only from client components after they have
 * asked whether the engine exists.
 */

/** What the caller is told while a sequence is spoken. */
export type SpeechHandlers = {
  /** Called with the index of the chunk that is starting. */
  onChunk?: (index: number) => void;
  /** Called when the last chunk has been spoken. */
  onDone?: () => void;
  /** Called when the engine refuses a chunk, with the index of that chunk. */
  onError?: (index: number) => void;
  /**
   * Called on a reading that another one has taken the voice from.
   *
   * Without it the page would keep showing 暂停 for a reading that is no longer
   * speaking: `cancel()` looks exactly like a chunk that ended, so the only
   * thing that knows the voice went elsewhere is the engine.
   */
  onTakeover?: () => void;
};

/** The handle on a reading in progress. */
export type Speaker = { stop: () => void };

/** The reading that currently owns the voice, if any. */
let current: { stop: () => void; takenOver: () => void } | null = null;

/**
 * Whether this browser can speak at all.
 *
 * Both halves are needed: an engine to speak, and a constructor for what it
 * says. Asking for one without the other is how a reader gets a button that
 * throws instead of speaking.
 */
export function speechSupported(): boolean {
  return typeof window !== "undefined"
    && typeof window.speechSynthesis !== "undefined"
    && typeof window.SpeechSynthesisUtterance === "function";
}

/**
 * Speak the texts in order, one at a time, taking the voice from anyone else.
 *
 * One utterance at a time rather than a queued batch: the caller marks what is
 * being spoken, and a queue cannot be paused mid-utterance without losing the
 * reader's place. It also makes 停止 immediate in the only sense that matters —
 * at most one chunk is still in the engine's mouth when it is called.
 */
export function speakSequence(texts: readonly string[], lang: string, handlers: SpeechHandlers = {}): Speaker {
  let stopped = false;
  const release = (): void => { if (current === speaker) current = null; };
  const takenOver = (): void => { handlers.onTakeover?.(); };
  const speaker: Speaker = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      release();
      try { window.speechSynthesis.cancel(); } catch { /* nothing was speaking */ }
    },
  };
  if (current) {
    const previous = current;
    current = null;
    previous.stop();
    previous.takenOver();
  }
  current = { stop: speaker.stop, takenOver };

  const step = (at: number): void => {
    if (stopped) return;
    const text = texts[at];
    if (text === undefined) {
      release();
      handlers.onDone?.();
      return;
    }
    handlers.onChunk?.(at);
    let utterance: SpeechSynthesisUtterance;
    try { utterance = new SpeechSynthesisUtterance(text); } catch {
      release();
      handlers.onError?.(at);
      return;
    }
    utterance.lang = lang;
    utterance.onend = () => {
      // `cancel()` reports itself here as well, so a stopped sequence does not
      // advance however the engine describes what happened.
      if (stopped) return;
      step(at + 1);
    };
    utterance.onerror = () => {
      if (stopped) return;
      release();
      handlers.onError?.(at);
    };
    try { window.speechSynthesis.speak(utterance); } catch {
      release();
      handlers.onError?.(at);
    }
  };

  step(0);
  return speaker;
}

/** Stop whatever is being spoken, if anything is. */
export function stopSpeaking(): void {
  current?.stop();
}
