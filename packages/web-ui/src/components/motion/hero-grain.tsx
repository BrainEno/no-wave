import { useEffect, useRef } from "react";
import { grainTileData } from "@/lib/chrome.ts";

const TILE_SIZE = 256;

/**
 * 首屏的流动颗粒：最早那版首屏（c144fb99 / 83aca16b）的观感有一半来自它。
 *
 * The early hero sat under a full-screen film-grain canvas that was redrawn
 * eight times a second at half resolution, over everything, multiplied at 7%.
 * 164eb653 replaced it with a still tile behind the content — the right call
 * for body text (a shifting layer over a long read is flicker, and the
 * per-pixel redraw was audit F-11's main-thread cost) — but the hero has an
 * opaque background, so since then the smear has had no grain on it at all and
 * reads as a clean video rather than wet paint.
 *
 * This brings the moving grain back on the hero only, without the cost: one
 * 256×256 tile is generated once and shown at twice its size (the early canvas
 * was half resolution), and a `steps()` animation in CSS jumps it to a new
 * offset every 125 ms — the old interval — so no frame touches a pixel in
 * script. It pauses while the hero is off screen and holds still under
 * reduced motion (see `.nw-hero-grain` in globals.css). Body text is never
 * under it.
 */
export function HeroGrain() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const tile = document.createElement("canvas");
    tile.width = TILE_SIZE;
    tile.height = TILE_SIZE;
    const context = tile.getContext("2d");
    if (!context) return;
    const image = context.createImageData(TILE_SIZE, TILE_SIZE);
    image.data.set(grainTileData(TILE_SIZE));
    context.putImageData(image, 0, 0);
    layer.style.backgroundImage = `url(${tile.toDataURL("image/png")})`;
    layer.dataset.ready = "";
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting ?? true) delete layer.dataset.paused;
      else layer.dataset.paused = "";
    });
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);
  return <div className="nw-hero-grain" ref={ref} aria-hidden="true" />;
}
