import assert from "node:assert/strict";
import test from "node:test";

import { passageAnchorFor, type SelectedPiece } from "./passage-selection.ts";

const SOURCE = "那年冬天，渡口的船停了，第一句留给划线。";

/**
 * The selection-to-anchor maths is the part of 划线 that can be checked
 * without a browser. The DOM reading and the effect timing live in the
 * component; everything that decides *which words* a mark covers is here.
 */
test("an existing selection is enough to build an anchor, with no mouseup event", () => {
  const pieces: SelectedPiece[] = [{ start: 0, from: 0, to: 5, text: "那年冬天，" }];
  const verdict = passageAnchorFor(pieces, SOURCE, 240);
  assert.equal(verdict.kind, "show");
  assert.equal(verdict.kind === "show" && verdict.anchor.text, "那年冬天，");
  assert.equal(verdict.kind === "show" && verdict.anchor.start, 0);
  assert.equal(verdict.kind === "show" && verdict.anchor.end, 5);
  assert.equal(verdict.kind === "show" && verdict.anchor.prefix, "");
  assert.equal(verdict.kind === "show" && verdict.anchor.suffix, SOURCE.slice(5));
});

test("leading and trailing whitespace is not part of what the reader meant", () => {
  // A real piece always satisfies `to - from === text.length`; model the
  // leading spaces as part of the indexed article text, not as padding that
  // appears out of nowhere.
  const padded = `  ${SOURCE}`;
  const pieces: SelectedPiece[] = [{ start: 0, from: 0, to: 8, text: "  那年冬天， " }];
  const verdict = passageAnchorFor(pieces, padded, 240);
  assert.equal(verdict.kind, "show");
  assert.equal(verdict.kind === "show" && verdict.anchor.text, "那年冬天，");
  assert.equal(verdict.kind === "show" && verdict.anchor.start, 2);
  assert.equal(verdict.kind === "show" && verdict.anchor.end, 7);
});

test("a selection spanning several text nodes starts at the first one", () => {
  const pieces: SelectedPiece[] = [
    { start: 0, from: 2, to: 5, text: "冬天，" },
    { start: 5, from: 0, to: 4, text: "渡口的船" },
  ];
  const verdict = passageAnchorFor(pieces, `${SOURCE.slice(0, 5)}${SOURCE.slice(5)}`, 240);
  assert.equal(verdict.kind, "show");
  assert.equal(verdict.kind === "show" && verdict.anchor.text, "冬天，渡口的船");
  assert.equal(verdict.kind === "show" && verdict.anchor.start, 2);
});

test("a collapsed, empty or whitespace-only selection offers no toolbar", () => {
  assert.equal(passageAnchorFor([], SOURCE, 240).kind, "hidden");
  assert.equal(passageAnchorFor([{ start: 0, from: 3, to: 3, text: "" }], SOURCE, 240).kind, "hidden");
  assert.equal(passageAnchorFor([{ start: 0, from: 0, to: 3, text: "   " }], SOURCE, 240).kind, "hidden");
});

test("a selection longer than the passage limit is refused, not silently clipped", () => {
  const verdict = passageAnchorFor([{ start: 0, from: 0, to: 5, text: "那年冬天，" }], SOURCE, 3);
  assert.equal(verdict.kind, "tooLong");
});
