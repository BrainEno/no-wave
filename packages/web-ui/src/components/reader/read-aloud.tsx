"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArticleContentBlock, Locale } from "@/lib/content.ts";
import { blockPosition, speakChunks, speechLang } from "@/lib/read-aloud.ts";

/**
 * 朗读 — reading the work aloud with the browser's own speech engine.
 *
 * ADR 0020: this is a browser capability and nothing else. There is no server
 * endpoint, no port method, no account data and no telemetry: the page already
 * has every word of the work, and the only thing that can say them is the
 * reader's own device. Where the engine is missing the control is absent rather
 * than disabled — a button that cannot work is a promise the page cannot keep.
 *
 * What is said is decided by `read-aloud.ts`, in units the reader counts: one
 * paragraph at a time, split only when a sentence is longer than a mouthful.
 * What is left here is the part that needs a browser — asking for one chunk at
 * a time, and following along.
 */

export type ReadAloudLabels = {
  listen: string;
  pause: string;
  resume: string;
  stop: string;
  /** `第 n 段，共 m 段` — n counts paragraphs, not chunks. */
  position: (n: number, total: number) => string;
  done: string;
  /** Shown when the engine refuses the first chunk: a reader who taps 朗读 and hears nothing is owed a sentence. */
  unavailable: string;
};

/** The element holding the spoken block gets this class while it is being read. */
const SPEAKING = "nw-speaking";

type ReadAloudProps = { blocks: readonly ArticleContentBlock[]; locale: Locale; labels: ReadAloudLabels };

export function ReadAloud({ blocks, locale, labels }: ReadAloudProps) {
  const [supported, setSupported] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [index, setIndex] = useState(-1);
  const [status, setStatus] = useState("");
  const chunks = useMemo(() => speakChunks(blocks), [blocks]);
  /** Whether a sequence is still ours: `cancel()` fires `onerror` on the utterance it kills. */
  const running = useRef(false);

  // The server cannot know whether the reader's browser can speak, and guessing
  // would put a control on the page that never works. So the first render — on
  // both sides — is nothing, and the answer is asked after hydration.
  useEffect(() => {
    // Both halves are needed: an engine to speak, and a constructor for what it
    // says. Asking for one without the other is how a reader gets a button that
    // throws instead of speaking.
    setSupported(typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance === "function");
  }, []);

  /** Mark the block being spoken, and keep it on screen while it is. */
  useEffect(() => {
    const blockId = index >= 0 ? chunks[index]?.blockId : undefined;
    if (!blockId) return;
    const node = document.querySelector(`[data-block="${CSS.escape(blockId)}"]`);
    if (!node) return;
    node.classList.add(SPEAKING);
    const box = node.getBoundingClientRect();
    // Only when it is out of view: a page that scrolls while the reader is
    // already looking at the paragraph takes the text away from them.
    if (box.top < 72 || box.bottom > window.innerHeight - 72) node.scrollIntoView({ block: "center" });
    return () => { node.classList.remove(SPEAKING); };
  }, [chunks, index]);

  const finish = useCallback((message: string) => {
    running.current = false;
    setPlaying(false);
    setPaused(false);
    setIndex(-1);
    setStatus(message);
  }, []);

  const stop = useCallback(() => {
    running.current = false;
    window.speechSynthesis.cancel();
    setPlaying(false);
    setPaused(false);
    setIndex(-1);
    setStatus("");
  }, []);

  /**
   * Speak from `position` to the end, one chunk at a time.
   *
   * One utterance at a time rather than a queued batch: the highlight follows
   * what is being said, and a queue cannot be paused mid-utterance without
   * losing the reader's place.
   */
  const speakFrom = useCallback((position: number) => {
    const step = (at: number): void => {
      const chunk = chunks[at];
      if (!chunk) {
        finish(labels.done);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunk.text);
      utterance.lang = speechLang(locale);
      utterance.onend = () => {
        if (!running.current) return;
        const where = blockPosition(chunks, at + 1);
        setIndex(at + 1);
        setStatus(where ? labels.position(where.position, where.total) : labels.done);
        step(at + 1);
      };
      utterance.onerror = () => {
        // `cancel()` reports this too, so only a sequence that is still ours
        // counts as a failure; otherwise stopping would look like an error.
        // A failure on the very first chunk is the reader's engine having no
        // voice to say it with, which is worth a sentence rather than silence.
        if (running.current) finish(at === 0 ? labels.unavailable : "");
      };
      window.speechSynthesis.speak(utterance);
    };
    step(position);
  }, [chunks, finish, labels, locale]);

  const start = useCallback(() => {
    window.speechSynthesis.cancel();
    running.current = true;
    const where = blockPosition(chunks, 0);
    setPlaying(true);
    setPaused(false);
    setIndex(0);
    setStatus(where ? labels.position(where.position, where.total) : "");
    speakFrom(0);
  }, [chunks, labels, speakFrom]);

  const toggle = useCallback(() => {
    if (!playing) {
      start();
      return;
    }
    if (paused) {
      window.speechSynthesis.resume();
      setPaused(false);
      return;
    }
    window.speechSynthesis.pause();
    setPaused(true);
  }, [paused, playing, start]);

  // Leaving the page is leaving the reading: an utterance that outlives its
  // article keeps talking over whatever the reader went to next.
  useEffect(() => () => {
    running.current = false;
    if (typeof window.speechSynthesis !== "undefined") window.speechSynthesis.cancel();
  }, []);

  if (!supported || chunks.length === 0) return null;

  return (
    <div className="nw-rs" role="group" aria-label={labels.listen} data-read-aloud>
      <button type="button" aria-pressed={playing && !paused} onClick={toggle} data-read-aloud-toggle>
        {playing ? (paused ? labels.resume : labels.pause) : labels.listen}
      </button>
      {playing ? (
        <button type="button" onClick={stop} data-read-aloud-stop>{labels.stop}</button>
      ) : null}
      <span className="nw-sr" role="status" aria-live="polite">{status}</span>
    </div>
  );
}
