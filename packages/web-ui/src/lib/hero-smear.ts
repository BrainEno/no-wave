/**
 * The hero's smear shader, run on the CPU — for the Canvas 2D fallback.
 *
 * `hero-canvas.tsx` draws the home hero with a fragment shader that has not
 * changed since the first port of the demo (c144fb99): a slow value-noise warp
 * of the picture, a ten-tap directional smear whose length is the remaining
 * reveal (`a = 1 - reveal`) plus the scroll velocity, a soft push of paint
 * around the pointer in the direction it moves, and a red channel sampled a
 * little further along the smear. When a browser cannot give the hero a WebGL
 * context, the fallback used to approximate that by drawing the picture several
 * times at horizontal offsets — which reads as brushed streaks, not wet paint,
 * and was the "different" hero people without WebGL saw.
 *
 * This is the same arithmetic as the shader, line for line, evaluated on a
 * small grid. Its output is an RGBA layer whose alpha is how strongly that
 * pixel is smeared, so the renderer can lay it over the sharp picture: where
 * nothing moves the picture stays sharp at full resolution, and where it moves
 * the low-resolution paint (upscaled with smoothing, which only softens it
 * further) takes over. The film grain line of the shader is left to the hero's
 * grain layer (`HeroGrain`).
 */

export type SmearSource = {
  /** RGBA pixels of the picture, row-major, top row first. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type SmearState = {
  /** Seconds since the renderer started (`t`). */
  time: number;
  /** 0 → fully smeared, 1 → clear (`Rv`). */
  reveal: number;
  /** Scroll velocity, about −1…1 (`S`). */
  scroll: number;
  /** Pointer position in 0…1, y up, like the shader's `v` (`M`). */
  pointerX: number;
  pointerY: number;
  /** Pointer velocity, clamped to ±1.5 (`MV`). */
  velocityX: number;
  velocityY: number;
};

const fract = (value: number) => value - Math.floor(value);

/** Cells between two evaluations of the warp noise. */
const NOISE_STEP = 8;

/** The shader's `h`: a hash of a 2D point into 0…1. */
export function smearHash(x: number, y: number): number {
  return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
}

/** The shader's `n`: smooth value noise. */
export function smearNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = smearHash(ix, iy);
  const b = smearHash(ix + 1, iy);
  const c = smearHash(ix, iy + 1);
  const d = smearHash(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

/**
 * How strongly anything is moving, frame-wide. Below a small threshold the
 * renderer skips the per-pixel pass and shows the sharp picture alone.
 */
export function smearActivity(state: SmearState): number {
  return Math.max(1 - state.reveal, Math.abs(state.scroll), Math.hypot(state.velocityX, state.velocityY));
}

/**
 * Fill `out` (RGBA, `width × height`, top row first) with the smeared picture.
 * `width`/`height` are the grid; the aspect ratio is the hero's, and the
 * picture is fitted like `object-fit: cover`, as the shader's `sc` does.
 */
export function renderSmear(out: Uint8ClampedArray, width: number, height: number, source: SmearSource, state: SmearState): void {
  const { data, width: sw, height: sh } = source;
  const amount = 1 - Math.max(0, Math.min(1, state.reveal));
  const aspect = width / height;
  const cover = Math.max(width / sw, height / sh);
  // uv = (v - .5) * R / (I * sc) + .5, with R and I in the same units.
  const spanX = width / (sw * cover);
  const spanY = height / (sh * cover);
  const warp = 0.012 + 0.07 * amount;
  const speed = Math.hypot(state.velocityX, state.velocityY);
  const t = state.time;
  const maxX = sw - 1;
  const maxY = sh - 1;
  // The warp noise changes about three times across the whole picture, so it
  // is evaluated on a lattice every NOISE_STEP cells and interpolated: the same
  // field to the eye, at a fraction of the `sin` calls.
  const latticeWidth = Math.ceil(width / NOISE_STEP) + 2;
  const latticeHeight = Math.ceil(height / NOISE_STEP) + 2;
  const noiseX = new Float32Array(latticeWidth * latticeHeight);
  const noiseY = new Float32Array(latticeWidth * latticeHeight);
  for (let ly = 0; ly < latticeHeight; ly += 1) {
    const w = 1 - ((1 - (ly * NOISE_STEP + 0.5) / height - 0.5) * spanY + 0.5);
    for (let lx = 0; lx < latticeWidth; lx += 1) {
      const u = ((lx * NOISE_STEP + 0.5) / width - 0.5) * spanX + 0.5;
      noiseX[ly * latticeWidth + lx] = smearNoise(u * 3 + t * 0.06, w * 3 + t * 0.06) - 0.5;
      noiseY[ly * latticeWidth + lx] = smearNoise(u * 3 + 9 - t * 0.05, w * 3 + 9 - t * 0.05) - 0.5;
    }
  }
  const pushing = speed > 0.0005;
  let index = 0;
  for (let py = 0; py < height; py += 1) {
    const vy = 1 - (py + 0.5) / height;
    const ly = Math.floor(py / NOISE_STEP);
    const ty = (py - ly * NOISE_STEP) / NOISE_STEP;
    for (let px = 0; px < width; px += 1) {
      const vx = (px + 0.5) / width;
      const u = (vx - 0.5) * spanX + 0.5;
      // The shader flips y after the cover fit: texture row 0 is the top.
      const w = 1 - ((vy - 0.5) * spanY + 0.5);
      const lx = Math.floor(px / NOISE_STEP);
      const tx = (px - lx * NOISE_STEP) / NOISE_STEP;
      const at00 = ly * latticeWidth + lx;
      const at10 = at00 + 1;
      const at01 = at00 + latticeWidth;
      const at11 = at01 + 1;
      const fx = (noiseX[at00]! * (1 - tx) + noiseX[at10]! * tx) * (1 - ty) + (noiseX[at01]! * (1 - tx) + noiseX[at11]! * tx) * ty;
      const fy = (noiseY[at00]! * (1 - tx) + noiseY[at10]! * tx) * (1 - ty) + (noiseY[at01]! * (1 - tx) + noiseY[at11]! * tx) * ty;
      const dx = (vx - state.pointerX) * aspect;
      const dy = vy - state.pointerY;
      const m = pushing ? Math.exp(-(dx * dx + dy * dy) * 16) : 0;
      const dirX = 0.12 * amount + state.velocityX * m * 0.9;
      const dirY = state.scroll * 0.14 + state.velocityY * m * 0.9;
      const ox = u + fx * warp + state.velocityX * m * 0.25;
      const oy = w + fy * warp + state.velocityY * m * 0.25;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let tap = 0; tap < 10; tap += 1) {
        const k = tap / 9 - 0.5;
        const sx = Math.min(maxX, Math.max(0, ((ox + dirX * k) * sw) | 0));
        const sy = Math.min(maxY, Math.max(0, ((oy + dirY * k) * sh) | 0));
        const at = (sy * sw + sx) * 4;
        r += data[at]!;
        g += data[at + 1]!;
        b += data[at + 2]!;
      }
      r /= 10;
      g /= 10;
      b /= 10;
      const split = 0.5 * Math.min(1, Math.max(0, amount + Math.abs(state.scroll) + speed * m * 2));
      const rx = Math.min(maxX, Math.max(0, ((ox + dirX * 0.62) * sw) | 0));
      const ry = Math.min(maxY, Math.max(0, ((oy + dirY * 0.62) * sh) | 0));
      r += (data[(ry * sw + rx) * 4]! - r) * split;
      // How smeared this pixel is: the remaining reveal, the scroll, and the
      // pointer's push where it is. The shader has no alpha; this is what lets
      // the sharp picture show through where the paint is still.
      const strength = Math.min(1, Math.max(0, amount * 1.6 + Math.abs(state.scroll) * 2.5 + speed * m * 4));
      out[index] = r;
      out[index + 1] = g;
      out[index + 2] = b;
      out[index + 3] = strength * 255;
      index += 4;
    }
  }
}
