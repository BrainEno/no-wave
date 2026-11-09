import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTICLE_VIEW_LIMIT,
  ARTICLE_VIEW_WINDOW_SECONDS,
  articleViewDay,
  articleViewKey,
  articleViewReader,
  articleViewsAvailable,
} from "./article-views.ts";

/**
 * What makes a view a view (ADR 0035).
 *
 * These are the pure parts of the counter: which day a read belongs to, who the
 * reader is, and how that pair becomes a key the database can hold without
 * knowing either of them. The service test next door covers the decision itself
 * (refuse the author, charge the bucket, increment); this file covers the
 * arithmetic that decision depends on, including the boundary it is easiest to
 * get wrong — midnight.
 */
test("a view day is the UTC date, and the boundary is midnight not 24 hours", () => {
  assert.equal(articleViewDay(new Date("2026-03-01T00:00:00.000Z")), "2026-03-01");
  assert.equal(articleViewDay(new Date("2026-03-01T23:59:59.999Z")), "2026-03-01");
  // One millisecond later is a different day, and therefore a different bucket —
  // the rule is a fixed line for everyone, not a window that follows the reader.
  assert.equal(articleViewDay(new Date("2026-03-02T00:00:00.000Z")), "2026-03-02");
  // The day is UTC, so a reader in Taipei at 08:00 local is still on the previous
  // UTC date. Stated here because a server-side "today" that depended on the
  // process timezone would make the counter differ per deployment.
  assert.equal(articleViewDay(new Date("2026-03-02T00:30:00.000+08:00")), "2026-03-01");
  assert.throws(() => articleViewDay(new Date("not a date")), TypeError);
});

test("a signed-in reader is keyed by account and an anonymous one by address", () => {
  assert.equal(articleViewReader("user-123", "203.0.113.9"), "user:user-123");
  assert.equal(articleViewReader(null, "203.0.113.9"), "address:203.0.113.9");
  // An empty address is still a bucket: "unknown" is a smaller crowd than "all
  // anonymous readers share one", and it is the only honest label available when
  // the transport could not name a peer.
  assert.equal(articleViewReader(null, ""), "address:unknown");
  // The two populations never collide: a digest of an id cannot stand in for a
  // digest of an address.
  assert.notEqual(articleViewReader("user-1", "1.2.3.4"), articleViewReader(null, "user-1"));
});

test("the dedupe key is keyed, stable, and scoped to the deployment's secret", () => {
  const secret = "s".repeat(40);
  const base = { secret, articleId: "9f0e3d2a-0000-4000-8000-000000000001", viewer: "user:reader-1", day: "2026-03-01" };
  const key = articleViewKey(base);
  assert.match(key, /^[0-9a-f]{64}$/, "the database holds a digest, never an address or an id");
  assert.equal(articleViewKey(base), key, "the same reader on the same day is the same bucket");
  assert.notEqual(articleViewKey({ ...base, viewer: "user:reader-2" }), key, "another reader is another bucket");
  assert.notEqual(articleViewKey({ ...base, day: "2026-03-02" }), key, "another day is another bucket");
  assert.notEqual(
    articleViewKey({ ...base, articleId: "9f0e3d2a-0000-4000-8000-000000000002" }),
    key,
    "another work is another bucket",
  );
  // Two deployments with different secrets do not agree on the digest, so one
  // database's keys are useless as a lookup table against another's.
  assert.notEqual(articleViewKey({ ...base, secret: "t".repeat(40) }), key);
  // The key says nothing about the reader: not the id, not the address, not the day.
  assert.ok(!key.includes("reader-1"));
  assert.throws(() => articleViewKey({ ...base, secret: "" }), TypeError);
});

test("view counting is unavailable without a secret long enough to key it", () => {
  assert.equal(articleViewsAvailable(undefined), false);
  assert.equal(articleViewsAvailable(""), false);
  assert.equal(articleViewsAvailable("short"), false);
  assert.equal(articleViewsAvailable("s".repeat(31)), false);
  assert.equal(articleViewsAvailable("s".repeat(32)), true, "the same floor the rest of the service uses");
});

test("one reader contributes one view per window", () => {
  assert.equal(ARTICLE_VIEW_LIMIT, 1);
  assert.equal(ARTICLE_VIEW_WINDOW_SECONDS, 86_400, "the bucket outlives its day by design: it is swept, not reused");
});
