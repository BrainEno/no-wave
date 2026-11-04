import { anchorIn, characterCount, type PassageAnchor } from "./passages.ts";

/**
 * The DOM-independent half of turning a reader's selection into a passage.
 *
 * `passage-annotations.tsx` reads the live `Range` and passes one clipped piece
 * per text node; this module decides which words the mark covers. Keeping that
 * decision pure means it can be verified without a browser, and means a
 * selection that already exists when the component's effects run is treated
 * exactly like one that arrived on a `mouseup`.
 */

/** One text node's contribution, already clipped to the selection's offsets. */
export type SelectedPiece = {
  /** Offset of the text node inside the indexed article text. */
  start: number;
  from: number;
  to: number;
  text: string;
};

export type PassageSelectionVerdict =
  | { kind: "hidden" }
  | { kind: "tooLong" }
  | { kind: "show"; anchor: PassageAnchor };

/**
 * Resolve the selected pieces into an anchor, or say why no toolbar should be
 * shown. Leading and trailing whitespace is not part of what the reader meant.
 */
export function passageAnchorFor(
  pieces: readonly SelectedPiece[],
  source: string,
  limit: number,
): PassageSelectionVerdict {
  let start = -1;
  let text = "";
  for (const piece of pieces) {
    if (piece.to <= piece.from) continue;
    if (start < 0) start = piece.start + piece.from;
    text += piece.text;
  }
  const trimmed = text.trim();
  if (start < 0 || trimmed.length === 0) return { kind: "hidden" };
  start += text.length - text.trimStart().length;
  const anchor = anchorIn(source, start, start + trimmed.length);
  if (characterCount(anchor.text) > limit) return { kind: "tooLong" };
  return { kind: "show", anchor };
}
