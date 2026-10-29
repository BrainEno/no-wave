import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * The migrated pages must ship their interactive halves.
 *
 * A page can be server-rendered perfectly and still be dead: if a `"use client"`
 * component is not in the client bundle, its markup arrives, nothing hydrates,
 * and every assertion that compares HTML — including `pnpm check:ssr-parity` —
 * stays green. React Router and the App Router build their client graphs
 * differently, so "it hydrates in Next.js" does not prove it hydrates here.
 *
 * The check is deliberately crude — a string that only exists in a component's
 * client-side code must appear in the emitted client assets. It cannot prove that
 * hydration succeeds (that needs a browser), but it proves the code is there:
 * the failure it catches is the one HTML comparison never can.
 */

const assetsDir = new URL("../build/client/assets/", import.meta.url);

type ClientComponent = {
  /** The shared client component. */
  component: string;
  /** A string literal that only appears in its client-side code. */
  sentinel: string;
  /** A migrated page that renders it. */
  page: string;
};

const CLIENT_COMPONENTS: readonly ClientComponent[] = [
  { component: "ArticleComments", sentinel: "/comments?locale=", page: "articles/:slug" },
  { component: "ReaderBar", sentinel: "nw-fs", page: "articles/:slug" },
  { component: "ReaderToc", sentinel: "nw-toc", page: "articles/:slug" },
  { component: "ReadingProgress", sentinel: "nw-progress", page: "articles/:slug" },
  { component: "PageLoader", sentinel: "nw-load", page: "/" },
  { component: "HomeLatest", sentinel: "nw-more", page: "/" },
  { component: "HeroGlCanvas", sentinel: "precision highp float", page: "/" },
];

function clientBundle(): string {
  assert.ok(
    existsSync(assetsDir),
    "The prototype must be built before its tests run: pnpm --filter @bot-thk/web-rr build",
  );
  const files = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
  assert.ok(files.length > 0, "the build emitted no client assets at all");
  return files.map((name) => readFileSync(new URL(name, assetsDir), "utf8")).join("\n");
}

test("every client component of a migrated page is present in the client bundle", () => {
  const bundle = clientBundle();
  for (const { component, sentinel, page } of CLIENT_COMPONENTS) {
    assert.ok(
      bundle.includes(sentinel),
      `${component} (rendered by ${page}) is missing from the client bundle — the page would render and never hydrate`,
    );
  }
});
