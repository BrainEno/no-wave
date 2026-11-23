import assert from "node:assert/strict";
import test from "node:test";
import { renderSmear, smearActivity, smearHash, smearNoise, type SmearState } from "./hero-smear.ts";

/** A 4×4 picture: left half red, right half blue. */
function picture() {
  const width = 4;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data.set(x < 2 ? [200, 0, 0, 255] : [0, 0, 200, 255], at);
    }
  }
  return { data, width, height };
}

const still: SmearState = { time: 0, reveal: 1, scroll: 0, pointerX: 0.5, pointerY: 0.5, velocityX: 0, velocityY: 0 };

test("the CPU smear uses the shader's own hash and noise", () => {
  // fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453), as in the GLSL.
  const expected = (x: number, y: number) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };
  for (const [x, y] of [[0, 0], [1, 2], [-3, 7.5]] as const) assert.equal(smearHash(x, y), expected(x, y));
  // Value noise passes through the hash at lattice points and stays in 0…1.
  assert.equal(smearNoise(2, 3), smearHash(2, 3));
  for (let i = 0; i < 50; i += 1) {
    const value = smearNoise(i * 0.37, i * 0.91);
    assert.ok(value >= 0 && value <= 1);
  }
});

test("a revealed, still hero leaves the sharp picture alone; a fresh one is fully smeared", () => {
  const source = picture();
  const out = new Uint8ClampedArray(8 * 8 * 4);
  renderSmear(out, 8, 8, source, still);
  for (let at = 3; at < out.length; at += 4) assert.equal(out[at], 0, "nothing moving: the overlay is transparent");
  assert.equal(smearActivity(still), 0);

  renderSmear(out, 8, 8, source, { ...still, reveal: 0 });
  for (let at = 3; at < out.length; at += 4) assert.equal(out[at], 255, "reveal 0: every cell is paint");
  assert.equal(smearActivity({ ...still, reveal: 0 }), 1);
  // The smear runs horizontally at reveal 0, so the centre mixes both halves.
  const centre = ((4 * 8) + 4) * 4;
  assert.ok(out[centre]! > 0 && out[centre + 2]! > 0, "the middle column carries both colours");
});

test("the pointer pushes paint only around itself", () => {
  const source = picture();
  const out = new Uint8ClampedArray(16 * 16 * 4);
  renderSmear(out, 16, 16, source, { ...still, pointerX: 0.25, pointerY: 0.5, velocityX: 1, velocityY: 0 });
  const alphaAt = (x: number, y: number) => out[((y * 16) + x) * 4 + 3]!;
  assert.ok(alphaAt(4, 8) > 200, "under the pointer");
  assert.ok(alphaAt(15, 0) < 10, "far corner untouched");
});
