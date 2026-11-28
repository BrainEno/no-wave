/**
 * The bands that float over the writing desk, and the room they need.
 *
 * The desk keeps two bands pinned over the prose: the format bar sticks to
 * the top of the editor, the action dock sticks to the bottom of the window.
 * Both are `position: sticky`, so they cover whatever text is underneath them.
 *
 * The browser's own "scroll the caret into view" knows nothing about that: it
 * parks the caret at the bottom of the scrollport, which is exactly where the
 * dock floats, and the author cannot see where they are typing. `scroll-padding`
 * on the scroll container is the mechanism that answers this — the browser
 * keeps that much room free at each edge when it brings the caret (or a
 * focused control) into view.
 *
 * The bands are measured rather than assumed, because the format bar wraps to
 * a second row at some widths and the dock grows a row when its buttons do
 * not fit; a hard-coded reserve would be wrong exactly where it matters.
 */

/** Which edge of the scrollport a floating band covers. */
export type FloatingBandEdge = "top" | "bottom";

export type FloatingBand = {
  edge: FloatingBandEdge;
  /** The band's own height, in CSS pixels. */
  height: number;
  /** How far the band keeps itself from that edge, in CSS pixels. */
  inset: number;
};

/** The room left between a floating band and the text it would otherwise cover. */
export const FLOATING_BAND_GAP = 12;

/**
 * The scroll padding the given bands need.
 *
 * For each edge, the band plus its inset plus the gap: the browser stops the
 * text it scrolls into view clear of the band instead of underneath it. The
 * tallest band on an edge wins — two bands on the same edge cannot both be
 * covered by the space one of them asks for.
 */
export function floatingBandScrollPadding(
  bands: readonly FloatingBand[],
  gap = FLOATING_BAND_GAP,
): { top: number; bottom: number } {
  const reserve = (edge: FloatingBandEdge): number =>
    bands
      .filter((band) => band.edge === edge)
      .reduce(
        (tallest, band) =>
          Math.max(tallest, band.height + band.inset + gap),
        0,
      );
  return { top: reserve("top"), bottom: reserve("bottom") };
}
