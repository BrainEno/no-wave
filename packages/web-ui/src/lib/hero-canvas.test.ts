import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../components/motion/hero-canvas.tsx", import.meta.url);

/**
 * React owns the <canvas> returned by HeroCanvas. A native remove() leaves the
 * Fiber tree pointing at a node that is no longer in the DOM, so unmounting the
 * home route can throw NotFoundError. The fallback must be a state change.
 */
test("HeroCanvas never removes a React-owned canvas directly", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.doesNotMatch(source, /canvas\.remove\s*\(/, "fallback must be rendered by React, not by DOM mutation");
  assert.match(source, /useState/, "fallback needs component state");
  assert.match(source, /setMode\(next\)/, "failed WebGL/2D/image branches must request the next renderer");
  assert.match(source, /key=\{mode\}/, "a canvas that held a WebGL context cannot give a 2D one: the fallback needs a fresh element");
});

/**
 * The smear follows the mouse as it moves over the hero, without a button held.
 * A drag-only version shipped once and made the hero look static to anyone who
 * just moved the mouse; it also left an anonymous window listener behind on
 * every unmount.
 */
test("HeroCanvas reacts to hover and removes every window listener it adds", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /hero\.addEventListener\("pointermove"/, "hover must move the paint");
  const added = [...source.matchAll(/window\.addEventListener\("(\w+)",\s*(\w+)\)/g)].map((match) => `${match[1]}:${match[2]}`);
  const removed = new Set([...source.matchAll(/window\.removeEventListener\("(\w+)",\s*(\w+)\)/g)].map((match) => `${match[1]}:${match[2]}`));
  assert.ok(added.length > 0);
  for (const listener of added) assert.ok(removed.has(listener), `window listener ${listener} is never removed`);
  assert.doesNotMatch(source, /window\.addEventListener\("\w+",\s*\(/, "an inline window listener cannot be removed");
});
