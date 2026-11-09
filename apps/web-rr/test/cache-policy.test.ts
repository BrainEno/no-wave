import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

/**
 * Every page route states its cache policy, and states it once (#F-18).
 *
 * This exists because one route did not. `/sign-in` renders `?next=<path>` and a
 * per-request `mailEnabled` answer, and it is where every other private route
 * sends a signed-out reader — and it shipped with no `headers` export at all, so
 * the only thing standing between it and a shared cache was a default nobody had
 * chosen. The recovery pages, `/write` and `/account` were fine; the page that
 * starts a session was not.
 *
 * Two properties are asserted, and both are about the *source* of a route
 * because the runtime version is already covered over real HTTP in
 * `web.test.ts` — a page can pass a no-store check today and lose the export in
 * a refactor tomorrow:
 *
 *   1. **Every page route is classified.** A new page that is added to
 *      `app/routes/` and to neither list fails here, which is the moment to
 *      decide whether it may be cached — not after it has been served.
 *   2. **The policy is the shared constant, never a spelling of it.** Four
 *      routes used to write `{ "Cache-Control": "no-store, max-age=0" }` by
 *      hand; four copies of a header is four chances to change three of them.
 */

const routesDir = new URL("../app/routes/", import.meta.url);

/**
 * Pages whose HTML depends only on public data. `s-maxage` is the whole point:
 * a free instance that sleeps cannot keep a page warm, an edge can.
 */
const PUBLIC_PAGES = ["article", "archive", "author", "authors", "categories", "category", "home"];

/**
 * Pages rendered per visitor or per query. `no-store`, because a shared cache
 * that keeps one of these hands somebody else's session, search or draft back.
 *
 * `sign-in` is the one that was missing its export; it belongs here because of
 * `?next=` and the per-request mail switch.
 */
const PRIVATE_PAGES = [
  "account",
  "admin.featured",
  "feed",
  "forgot-password",
  "messages",
  "messages.$id",
  "reset-password",
  "search",
  "sign-in",
  "verify-email",
  "write",
  "write.media",
  "write.notion",
];

async function pageRouteModules(): Promise<string[]> {
  const files = await readdir(routesDir);
  // Resource routes (`api.*`, `robots.txt`, `sitemap.xml`) are `.ts` and answer
  // with their own content type; this test is about server-rendered pages.
  return files
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => name.replace(/\.tsx$/, ""))
    .sort();
}

test("every page route declares whether it may be cached", async () => {
  const modules = await pageRouteModules();
  assert.ok(modules.length >= 19, `expected the page routes to be found, saw ${modules.length}`);

  // Both directions: an unlisted route is an unclassified one, and a listed
  // route with no file is a list that has drifted from the router.
  const declared = new Set([...PUBLIC_PAGES, ...PRIVATE_PAGES]);
  assert.deepEqual(
    modules.filter((name) => !declared.has(name)),
    [],
    "these routes are neither public nor private: add them to a list in this test, and to `headers` in the route",
  );
  assert.deepEqual(
    [...declared].filter((name) => !modules.includes(name)).sort(),
    [],
    "these routes are listed here but no longer exist",
  );
  const overlap = PUBLIC_PAGES.filter((name) => PRIVATE_PAGES.includes(name));
  assert.deepEqual(overlap, [], "a route cannot be both");
});

for (const [kind, modules] of [
  ["PUBLIC", PUBLIC_PAGES],
  ["PRIVATE", PRIVATE_PAGES],
] as const) {
  test(`every ${kind.toLowerCase()} page route exports the shared ${kind} policy`, async () => {
    const wrong: string[] = [];
    const missing = [] as string[];
    const respelled = [] as string[];
    for (const name of modules) {
      const source = await readFile(new URL(`${name}.tsx`, routesDir), "utf8");
      if (!source.includes("export const headers")) missing.push(name);
      if (!source.includes(`${kind}_PAGE_HEADERS`)) wrong.push(name);
      // A literal header in a route is the drift this test exists to prevent:
      // the policy belongs in `app/lib/http-policy.ts` and nowhere else.
      if (source.includes('"Cache-Control"')) respelled.push(name);
    }
    assert.deepEqual(missing, [], "these routes render without stating a cache policy");
    assert.deepEqual(wrong, [], `these routes do not use ${kind}_PAGE_HEADERS`);
    assert.deepEqual(respelled, [], "these routes spell the header themselves instead of using http-policy.ts");
  });
}
