import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

/**
 * Every BFF module must be reachable (#198).
 *
 * This exists because it happened: PR #201 shipped the save control with a
 * resource route at `app/routes/api.articles.$slug.like.ts` and no entry in the
 * explicit route table. The file sat there, correct and unimported, and every
 * request to it answered 404. The proxy had fourteen passing contract tests and
 * the component had seven; none of them could see the problem, because they
 * tested the handler directly and never asked whether anything routed to it.
 *
 * A capability that is implemented but unrouted is not shipped. The route table
 * is explicit, so "is it wired up" is a question this repository can answer by
 * reading two files — which is what this test does.
 */

const routesDir = new URL("../../../../apps/web-rr/app/routes/", import.meta.url);
const tablePath = new URL("../../../../apps/web-rr/app/routes.ts", import.meta.url);

test("every api.* module under app/routes is registered in the route table", async () => {
  const table = await readFile(tablePath, "utf8");
  const files = await readdir(routesDir);
  const modules = files.filter((name) => name.startsWith("api.") && /\.tsx?$/.test(name));
  assert.ok(modules.length > 10, `expected a populated routes directory, saw ${modules.length}`);

  const missing = modules.filter((name) => !table.includes(`routes/${name}`));
  assert.deepEqual(
    missing,
    [],
    `these modules exist but nothing routes to them (a 404 at runtime):\n  ${missing.join("\n  ")}`,
  );
});

test("the save, follow and author-profile endpoints are wired", async () => {
  const table = await readFile(tablePath, "utf8");
  // Named individually as well, because a rename that deletes one of these from
  // the table while keeping the file would otherwise pass the sweep above only
  // if the file were also deleted — and deleting both is exactly the silent
  // regression this guards.
  for (const [path, module] of [
    ["api/articles/:slug/like", "routes/api.articles.$slug.like.ts"],
    ["api/users/:userId/follow", "routes/api.users.$userId.follow.ts"],
    ["api/authors/:userId", "routes/api.authors.$userId.ts"],
  ] as const) {
    assert.ok(
      table.includes(`route("${path}", "${module}")`),
      `${path} must route to ${module}`,
    );
  }
});

test("a route path and its module agree about the params they use", async () => {
  // `:userId` in the path must be `$userId` in the module name, or the handler
  // reads `params.userId` and gets `undefined` — which the proxy turns into a
  // 400 that looks like the caller's fault.
  const table = await readFile(tablePath, "utf8");
  const entries = [...table.matchAll(/route\("([^"]+)",\s*"routes\/([^"]+)"\)/g)];
  assert.ok(entries.length > 10, "the table should have parsed");

  for (const [, path, module] of entries) {
    // Only `api.*` resource modules follow the `$param` naming convention.
    // Page routes (`author.tsx`, `category.tsx`) are shared across paths and
    // carry their params some other way, so applying the rule to them would
    // assert a convention this repository does not actually have.
    if (!module.startsWith("api.")) continue;
    // Only one direction is asserted: every `$param` in a module name must be
    // declared by its path. The reverse is not a rule this repository follows —
    // `api/auth/:action` is served by `api.auth.ts`, which reads the action from
    // the URL. Asserting both directions would fail on working code.
    const pathParams = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    const moduleParams = [...module.matchAll(/\$([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    for (const param of moduleParams) {
      assert.ok(
        pathParams.includes(param),
        `${module} carries $${param} but ${path} does not declare :${param}`,
      );
    }
  }
});
