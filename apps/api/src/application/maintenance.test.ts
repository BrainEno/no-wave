import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_MAINTENANCE_ARTICLE_LIMIT,
  DEFAULT_MAINTENANCE_MAX_PASSES,
  runMaintenance,
  type MaintenanceReport,
} from "./maintenance.ts";
import { createSqliteClient, runSqliteMigrations } from "../persistence/sqlite.ts";
import { createSqliteStore } from "../persistence/sqlite-store.ts";

/**
 * The maintenance run an operator schedules (audit F-22).
 *
 * The sweeps themselves were already bounded and safe; the problem was that they
 * only happened when *something else* wrote: a quiet instance — which is the
 * normal shape of a self-hosted single-author site — never pruned an expired
 * session, an expired rate-limit row or an expired tombstone. This is the
 * explicit trigger, and these tests pin the three properties that make it safe to
 * schedule: it converges, it is bounded, and a failing sweep is *reported*
 * instead of being swallowed.
 */

const HOUR = 3_600_000;

type FakeSweeps = {
  /** Counts returned by successive identity sweeps; the last value repeats. */
  identity?: number[];
  /** Counts returned by successive tombstone sweeps; the last value repeats. */
  articles?: number[];
  identityError?: Error;
  articleError?: Error;
};

function fakeStore({ identity = [0], articles = [0], identityError, articleError }: FakeSweeps) {
  const calls = {
    identity: 0,
    articles: [] as Array<{ retentionDays: number; now: Date; limit: number }>,
  };
  const next = (values: number[], index: number) => values[Math.min(index, values.length - 1)] ?? 0;
  return {
    calls,
    store: {
      async pruneExpiredIdentityState() {
        const value = next(identity, calls.identity);
        calls.identity += 1;
        if (identityError) throw identityError;
        return { sessions: value, rateLimits: value, revokedSessions: value, identityTokens: value };
      },
      async purgeExpiredArticles(input: { retentionDays: number; now: Date; limit: number }) {
        const value = next(articles, calls.articles.length);
        calls.articles.push({ ...input });
        if (articleError) throw articleError;
        return { purged: value };
      },
    },
  };
}

test("a backlog is drained over bounded passes, and the run stops when a pass removes nothing", async () => {
  const { store, calls } = fakeStore({ identity: [3, 2, 0], articles: [4, 1, 0] });
  const report = await runMaintenance({ store, env: {}, maxPasses: 5, articleLimit: 50 });

  assert.equal(report.passes, 3, "the third pass removed nothing, so there is no fourth");
  assert.equal(report.converged, true);
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.removed, {
    sessions: 5, rateLimits: 5, revokedSessions: 5, identityTokens: 5, articles: 5,
  });
  assert.equal(calls.identity, 3);
  assert.equal(calls.articles.length, 3);
});

test("a source that never converges is cut off at the pass limit, not looped forever", async () => {
  const { store, calls } = fakeStore({ identity: [2], articles: [3] });
  const report = await runMaintenance({ store, env: {}, maxPasses: 2, articleLimit: 25 });

  assert.equal(report.passes, 2);
  assert.equal(report.converged, false, "hitting the cap is not convergence and must not claim to be");
  assert.equal(report.ok, true);
  assert.equal(report.removed.articles, 6);
  assert.equal(calls.articles.length, 2);
});

test("a failing sweep is reported by class only, and does not stop the other one", async () => {
  // A driver message can contain a connection string; the report goes to a log
  // line the operator keeps, so only the class may travel.
  const { store, calls } = fakeStore({
    identity: [1],
    articles: [2],
    identityError: new Error("connect failed for postgres://writer:hunter2@db.internal:5432/no_wave"),
  });
  const report = await runMaintenance({ store, env: {}, maxPasses: 3, articleLimit: 100 });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures, [{ task: "identity-prune", errorName: "Error" }]);
  assert.equal(JSON.stringify(report).includes("hunter2"), false, "no driver message may reach the report");
  assert.equal(JSON.stringify(report).includes("db.internal"), false);
  assert.equal(report.removed.articles, 2, "the tombstone sweep still ran");
  assert.equal(calls.articles.length, 1, "a failed sweep is not retried in the same run");
  assert.equal(report.converged, false, "a failed sweep cannot prove the backlog is drained");
});

test("the retention window is the same one the write path uses", async () => {
  const { store, calls } = fakeStore({ identity: [0], articles: [1] });
  const now = new Date("2026-11-07T00:00:00.000Z");
  await runMaintenance({ store, env: { ARTICLE_TOMBSTONE_RETENTION_DAYS: "7" }, now, maxPasses: 2, articleLimit: 40 });

  assert.deepEqual(calls.articles[0], { retentionDays: 7, now, limit: 40 });
});

test("invalid bounds are rejected before a single row is touched", async () => {
  const { store, calls } = fakeStore({});
  for (const maxPasses of [0, -1, 1.5, 21, Number.NaN]) {
    await assert.rejects(runMaintenance({ store, env: {}, maxPasses }), RangeError, `maxPasses ${String(maxPasses)}`);
  }
  for (const articleLimit of [0, 501, 2.5]) {
    await assert.rejects(runMaintenance({ store, env: {}, articleLimit }), RangeError, `articleLimit ${String(articleLimit)}`);
  }
  assert.equal(calls.identity, 0);
  assert.equal(calls.articles.length, 0);
  assert.ok(DEFAULT_MAINTENANCE_MAX_PASSES >= 1 && DEFAULT_MAINTENANCE_ARTICLE_LIMIT >= 1);
});

test("the documented defaults are what an unconfigured run uses", async () => {
  const { store, calls } = fakeStore({});
  const report: MaintenanceReport = await runMaintenance({ store, env: {} });
  assert.equal(report.passes, 1, "an empty database converges on the first pass");
  assert.equal(calls.articles[0]?.limit, DEFAULT_MAINTENANCE_ARTICLE_LIMIT);
  assert.equal(calls.articles[0]?.retentionDays, 30, "the shipped retention default");
});

/**
 * The end-to-end half, against a real SQLite database.
 *
 * It seeds the three kinds of expired row by using the store's own writes and
 * then moving time backwards, so the assertion is "a quiet instance's backlog is
 * actually gone" rather than "the functions were called".
 */
test("a real database drops expired sessions, expired rate-limit rows and expired tombstones", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const store = createSqliteStore(db);
  const userId = `maintenance-owner-${randomUUID()}`;
  try {
    await store.createIdentityAccount({
      userId,
      email: `maintenance-${randomUUID()}@example.test`,
      passwordHash: "hash",
      session: {
        sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
        refreshHash: randomUUID().replace(/-/g, "").padEnd(64, "b"), expiresAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
        accessExpiresAt: new Date(Date.now() + HOUR).toISOString(),
      },
    });
    const article = await store.createArticle({
      authorId: userId, slug: `maintenance-${randomUUID()}`, title: "将被清掉", summary: "",
      locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }], publish: false,
    });
    // The column carries a CHECK on 64 characters: the real callers hash their
    // subject, so the test does the same rather than inventing a short key.
    const rateLimitKey = createHash("sha256").update(randomUUID()).digest("hex");
    await store.consumeRateLimit({ key: rateLimitKey, limit: 5, windowSeconds: 60 });

    // Move everything into the past: the session expired more than a day ago and
    // has no valid access token, the counter's window closed, and the work has
    // been in the recycle bin longer than the retention window.
    const longAgo = new Date(Date.now() - 60 * 24 * HOUR).toISOString();
    db.prepare("UPDATE auth_sessions SET expires_at = ?").run(longAgo);
    db.prepare("UPDATE auth_access_tokens SET expires_at = ?").run(longAgo);
    db.prepare("UPDATE auth_rate_limits SET reset_at = ? WHERE key = ?").run(longAgo, rateLimitKey);
    db.prepare("UPDATE articles SET deleted_at = ? WHERE id = ?").run(longAgo, article.id);

    const report = await runMaintenance({ store, env: {}, maxPasses: 3, articleLimit: 100 });
    assert.equal(report.ok, true, JSON.stringify(report.failures));
    assert.ok(report.removed.sessions >= 1, "the expired session is gone");
    assert.ok(report.removed.rateLimits >= 1, "the closed rate-limit window is gone");
    assert.equal(report.removed.articles, 1, "the expired tombstone is gone");

    assert.equal(db.prepare("SELECT count(*) AS count FROM auth_sessions").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM auth_rate_limits WHERE key = ?").get(rateLimitKey).count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM articles WHERE id = ?").get(article.id).count, 0);

    // A second run is the no-op a scheduler needs it to be.
    const again = await runMaintenance({ store, env: {}, maxPasses: 3, articleLimit: 100 });
    assert.equal(again.ok, true);
    assert.equal(again.converged, true);
    assert.equal(again.removed.articles, 0);
  } finally {
    db.close();
  }
});

test("the reporter sees what the report says, and a throwing reporter cannot fail the run", async () => {
  const reported: Array<{ task: string; errorName: string }> = [];
  const { store } = fakeStore({
    articles: [1],
    articleError: Object.assign(new Error("connect failed for postgres://writer:hunter2@db.internal:5432/no_wave"), {
      name: "PostgresError",
    }),
  });
  const report = await runMaintenance({
    store,
    env: {},
    maxPasses: 2,
    articleLimit: 10,
    onBackgroundFailure: (failure) => reported.push(failure),
  });

  assert.deepEqual(reported, [{ task: "tombstone-purge", errorName: "PostgresError" }]);
  assert.deepEqual(report.failures, reported, "the sink and the report must not disagree");
  assert.equal(report.ok, false);
  assert.equal(report.removed.articles, 0);
  assert.equal(JSON.stringify(report).includes("hunter2"), false);

  // A sink that throws is an operator's bug, not a reason to fail the sweep.
  const { store: healthy } = fakeStore({ identity: [1, 0], articles: [1, 0] });
  const second = await runMaintenance({
    store: healthy,
    env: {},
    maxPasses: 2,
    onBackgroundFailure: () => { throw new Error("the log sink is closed"); },
  });
  assert.equal(second.ok, true);
  assert.equal(second.converged, true);
});

test("an error is reduced to a class name, or to a fixed placeholder when it has none worth logging", async () => {
  // Driver messages can contain connection strings and bind parameters, so only
  // the class travels. A class that is not an identifier is not truncated: a
  // mangled name is a wrong name.
  const cases: Array<[unknown, string]> = [
    [new RangeError("boom"), "RangeError"],
    [Object.assign(new Error("x"), { name: "not an identifier" }), "Error"],
    [Object.assign(new Error("x"), { name: "A".repeat(65) }), "Error"],
    [Object.assign(new Error("x"), { name: "" }), "Error"],
    ["just a string", "NonErrorThrow"],
    [undefined, "NonErrorThrow"],
    [{ code: 42 }, "NonErrorThrow"],
  ];
  for (const [thrown, expected] of cases) {
    const { store } = fakeStore({});
    store.pruneExpiredIdentityState = async () => { throw thrown; };
    const report = await runMaintenance({ store, env: {}, maxPasses: 1 });
    assert.deepEqual(report.failures, [{ task: "identity-prune", errorName: expected }], String(thrown));
    assert.equal(report.ok, false);
  }
});
