import assert from "node:assert/strict";
import test from "node:test";

import {
  FLOATING_BAND_GAP,
  floatingBandScrollPadding,
  type FloatingBand,
} from "./floating-bands.ts";

/**
 * The writing desk's floating bands (the format bar at the top of the editor,
 * the action dock at the bottom of the window) cover the prose underneath them.
 * These are the rules that decide how much room the browser has to leave free
 * when it scrolls the caret into view, so the caret never ends up behind a
 * band the author cannot see through.
 */

const toolbar: FloatingBand = { edge: "top", height: 50, inset: 0 };
const dock: FloatingBand = { edge: "bottom", height: 60, inset: 16 };

test("a page without bands asks for no room at all", () => {
  assert.deepEqual(floatingBandScrollPadding([]), { top: 0, bottom: 0 });
});

test("each band asks for its own height, its inset and the gap", () => {
  assert.deepEqual(floatingBandScrollPadding([toolbar, dock]), {
    top: 50 + FLOATING_BAND_GAP,
    bottom: 60 + 16 + FLOATING_BAND_GAP,
  });
});

test("the tallest band on an edge is the one that counts", () => {
  const wrappedToolbar: FloatingBand = { edge: "top", height: 94, inset: 0 };
  assert.deepEqual(
    floatingBandScrollPadding([toolbar, wrappedToolbar]).top,
    94 + FLOATING_BAND_GAP,
  );
  assert.deepEqual(floatingBandScrollPadding([wrappedToolbar, toolbar]).top, 94 + FLOATING_BAND_GAP);
});

test("a band on one edge does not ask for room on the other", () => {
  assert.deepEqual(floatingBandScrollPadding([dock]), {
    top: 0,
    bottom: 60 + 16 + FLOATING_BAND_GAP,
  });
});

test("the gap is the distance between the band and the text above it", () => {
  assert.deepEqual(floatingBandScrollPadding([toolbar], 24), { top: 74, bottom: 0 });
});
