import assert from "node:assert/strict";
import test from "node:test";

import { REST_ROUTES } from "./routes.ts";
import { ARTICLE_ROUTE_IDS } from "./routes/articles.ts";
import { AUTH_ROUTE_IDS } from "./routes/auth.ts";
import { AUTHOR_ROUTE_IDS } from "./routes/authors.ts";
import { CONVERSATION_ROUTE_IDS } from "./routes/conversations.ts";
import { HEALTH_ROUTE_IDS } from "./routes/health.ts";
import { IDENTITY_ROUTE_IDS } from "./routes/identity.ts";
import { MEDIA_ROUTE_IDS } from "./routes/media.ts";
import { NOTIFICATION_ROUTE_IDS } from "./routes/notifications.ts";
import { TAXONOMY_ROUTE_IDS } from "./routes/taxonomies.ts";

/**
 * Dispatch coverage.
 *
 * `routes.ts` decides which URL exists and which methods it accepts; the group
 * modules decide who answers it. Those are two different files, so a route can be
 * declared but never claimed (a silent 404 on a documented endpoint) or claimed
 * twice (the second handler is dead code and the first one silently wins).
 * Neither is visible in review — both are visible here.
 */

const GROUPS: readonly { name: string; ids: readonly string[] }[] = [
  { name: "auth", ids: AUTH_ROUTE_IDS },
  { name: "media", ids: MEDIA_ROUTE_IDS },
  { name: "health", ids: HEALTH_ROUTE_IDS },
  { name: "identity", ids: IDENTITY_ROUTE_IDS },
  { name: "notifications", ids: NOTIFICATION_ROUTE_IDS },
  { name: "conversations", ids: CONVERSATION_ROUTE_IDS },
  { name: "articles", ids: ARTICLE_ROUTE_IDS },
  { name: "authors", ids: AUTHOR_ROUTE_IDS },
  { name: "taxonomies", ids: TAXONOMY_ROUTE_IDS },
];

test("every declared route is claimed by exactly one group", () => {
  const claims = new Map<string, string[]>();
  for (const group of GROUPS) {
    for (const id of group.ids) {
      claims.set(id, [...(claims.get(id) ?? []), group.name]);
    }
  }

  const declared = REST_ROUTES.map((route) => route.id);
  assert.equal(new Set(declared).size, declared.length, "route ids in the table must be unique");

  for (const id of declared) {
    const owners = claims.get(id) ?? [];
    assert.equal(owners.length, 1, `route "${id}" is claimed by ${owners.length} groups: ${owners.join(", ") || "none"}`);
  }
});

test("no group claims a route id that the table does not declare", () => {
  const declared = new Set(REST_ROUTES.map((route) => route.id));
  for (const group of GROUPS) {
    for (const id of group.ids) {
      assert.ok(declared.has(id), `group "${group.name}" claims unknown route id "${id}"`);
    }
  }
});

test("route ids are grouped where a reader would look for them", () => {
  // A failed assertion here is not a bug — it is a request to move the handler
  // into the module that owns the domain, which is the point of the split.
  const byGroup = new Map(GROUPS.map((group) => [group.name, new Set(group.ids)]));
  const expectations: readonly [string, readonly string[]][] = [
    ["health", ["health"]],
    ["auth", ["auth"]],
    ["media", ["media.item", "me.media"]],
    ["identity", ["me", "me.email-verification", "me.password", "me.profile", "me.session", "users", "users.relationships", "users.follow"]],
    ["notifications", ["me.notifications", "me.notifications.unread-count", "me.notifications.read", "me.notifications.read-all"]],
    ["authors", ["authors.item", "authors.articles"]],
    ["taxonomies", ["categories", "categories.item", "categories.articles", "tags", "tags.item", "tags.articles", "taxonomies", "taxonomies.item"]],
  ];

  for (const [name, expected] of expectations) {
    const actual = byGroup.get(name);
    assert.ok(actual, `missing group "${name}"`);
    assert.deepEqual([...actual].sort(), [...expected].sort(), `group "${name}" owns the wrong route ids`);
  }
});
