import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * React owns the <canvas> returned by HeroCanvas. A native remove() leaves the
 * Fiber tree pointing at a node that is no longer in the DOM, so unmounting the
 * home route can throw NotFoundError. The fallback must be a state change.
 */
test("HeroCanvas never removes a React-owned canvas directly", async () => {
  const source = await readFile(new URL("../components/motion/hero-canvas.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /canvas\.remove\s*\(/, "fallback must be rendered by React, not by DOM mutation");
  assert.match(source, /useState/, "fallback needs component state");
  assert.match(source, /setFallback\(true\)/, "failed WebGL/image branches must request the fallback");
});
