import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createIdentityService } from "../application/identity.ts";
import { IdentityAuthenticationError, IdentityRateLimitError } from "../domain/errors.ts";
import { createRefreshQuotaFixture, refreshDigest } from "./test-support/refresh-quota-fixture.ts";

for (const provider of ["sqlite", "postgres"] as const) {
  const options = { skip: provider === "postgres" && !process.env.TEST_DATABASE_URL };

  test(`${provider}: refresh lookup returns only stable quota metadata and consumed hashes keep that identity`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const before = await f.store.findIdentityRefreshSession({ refreshHash: f.initial.refreshHash });
    assert.deepEqual(before, { sessionId: f.initial.sessionId });
    assert.deepEqual(Object.keys(before!), ["sessionId"]);
    assert.deepEqual(await f.buckets(), [], "a lookup cannot consume quota or rotate");
    const rotated = await f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7");
    const consumed = await f.store.findIdentityRefreshSession({ refreshHash: f.initial.refreshHash });
    const current = await f.store.findIdentityRefreshSession({ refreshHash: refreshDigest(rotated.refreshToken) });
    assert.deepEqual(consumed, before);
    assert.deepEqual(current, before);
    const rows = await f.refreshRows();
    assert.equal(rows.length, 2);
    assert.equal(rows.filter(({ used_at }) => used_at !== null).length, 1);
    assert.equal((await f.buckets())[0]!.attempts, 1);
    assert.equal(JSON.stringify(current).includes(rotated.refreshToken), false);
  });

  test(`${provider}: 121 live sessions of one account each refresh once on one NAT without a shared 120/IP ceiling`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const sessions = [f.initial];
    for (let index = 1; index < 121; index++) sessions.push(await f.seedSession());
    const rotated = [];
    for (const session of sessions) rotated.push(await f.service.refresh({ refreshToken: session.refreshToken }, "192.0.2.7"));
    assert.equal(rotated.length, 121);
    assert.equal(new Set(rotated.map(({ refreshToken }) => refreshToken)).size, 121);
    assert.equal(new Set(rotated.map(({ accessToken }) => accessToken)).size, 121);
    const buckets = await f.buckets();
    assert.equal(buckets.length, 121);
    assert.ok(buckets.every(({ attempts }) => attempts === 1));
    assert.equal(buckets.some(({ key }) => key === f.rateKey("refresh:ip", "192.0.2.7")), false);
    for (const [index, tokens] of rotated.entries()) {
      assert.equal(tokens.tokenType, "Bearer");
      assert.equal(new Date(tokens.refreshExpiresAt).getTime(), new Date(sessions[index]!.expiresAt).getTime());
      assert.deepEqual(await f.store.findIdentityRefreshSession({ refreshHash: refreshDigest(tokens.refreshToken) }), { sessionId: sessions[index]!.sessionId });
    }
  });

  test(`${provider}: 120 real rotations exhaust one stable session across services, tokens and IP changes`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const secondService = createIdentityService({ store: f.store, env: f.env });
    let current = f.initial.refreshToken;
    for (let index = 0; index < 120; index++) {
      const service = index % 2 === 0 ? f.service : secondService;
      current = (await service.refresh({ refreshToken: current }, index % 2 === 0 ? "192.0.2.7" : "2001:db8::7")).refreshToken;
    }
    const rowsBefore = await f.refreshRows();
    assert.equal(rowsBefore.length, 121);
    assert.equal(rowsBefore.filter(({ used_at }) => used_at === null).length, 1);
    await assert.rejects(secondService.refresh({ refreshToken: current }, "198.51.100.99"), (error: unknown) => {
      assert.ok(error instanceof IdentityRateLimitError);
      assert.ok(error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 900);
      return true;
    });
    assert.deepEqual(await f.refreshRows(), rowsBefore, "429 must not consume the current refresh credential");
    const buckets = await f.buckets();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.key, f.rateKey("refresh:session", f.initial.sessionId));
    assert.equal(buckets[0]!.attempts, 121);
  });

  test(`${provider}: an exhausted device does not throttle another device of the same owner`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const second = await f.seedSession();
    for (let attempt = 0; attempt < 120; attempt++) await f.store.consumeRateLimit({ key: f.rateKey("refresh:session", f.initial.sessionId), limit: 120, windowSeconds: 900 });
    await assert.rejects(f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7"), IdentityRateLimitError);
    const independent = await f.service.refresh({ refreshToken: second.refreshToken }, "192.0.2.7");
    assert.equal(independent.tokenType, "Bearer");
    assert.deepEqual(await f.store.findIdentityRefreshSession({ refreshHash: refreshDigest(independent.refreshToken) }), { sessionId: second.sessionId });
    assert.equal((await f.refreshRows(f.initial.sessionId)).length, 1);
    assert.equal((await f.refreshRows(second.sessionId)).length, 2);
    const buckets = await f.buckets();
    assert.equal(buckets.length, 2);
    assert.equal(buckets.find(({ key }) => key === f.rateKey("refresh:session", second.sessionId))!.attempts, 1);
  });

  test(`${provider}: unknown-token spraying remains 120/IP and cannot consume a live session's bucket`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    for (let attempt = 0; attempt < 120; attempt++) await assert.rejects(f.service.refresh({ refreshToken: randomBytes(32).toString("base64url") }, "192.0.2.7"), IdentityAuthenticationError);
    await assert.rejects(f.service.refresh({ refreshToken: randomBytes(32).toString("base64url") }, "192.0.2.7"), IdentityRateLimitError);
    const valid = await f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7");
    assert.equal(valid.tokenType, "Bearer");
    const buckets = await f.buckets();
    assert.equal(buckets.length, 2, "random tokens must not allocate unbounded per-token counters");
    assert.equal(buckets.find(({ key }) => key === f.rateKey("refresh:ip", "192.0.2.7"))!.attempts, 121);
    assert.equal(buckets.find(({ key }) => key === f.rateKey("refresh:session", f.initial.sessionId))!.attempts, 1);
    assert.equal((await f.refreshRows()).length, 2);
    assert.ok(buckets.every(({ key }) => /^[a-f0-9]{64}$/.test(key)));
  });

  test(`${provider}: revoked and expired families cannot be used as trusted quota identities`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const expired = await f.seedSession();
    await f.expireSession(expired.sessionId);
    await f.store.revokeIdentityRefresh({ refreshHash: f.initial.refreshHash });
    assert.equal(await f.store.findIdentityRefreshSession({ refreshHash: f.initial.refreshHash }), null);
    assert.equal(await f.store.findIdentityRefreshSession({ refreshHash: expired.refreshHash }), null);
    await assert.rejects(f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7"), IdentityAuthenticationError);
    await assert.rejects(f.service.refresh({ refreshToken: expired.refreshToken }, "192.0.2.7"), IdentityAuthenticationError);
    const buckets = await f.buckets();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.key, f.rateKey("refresh:ip", "192.0.2.7"));
    assert.equal(buckets[0]!.attempts, 2);
    assert.equal((await f.refreshRows()).length, 1);
    assert.equal((await f.refreshRows(expired.sessionId)).length, 1);
  });

  test(`${provider}: replay still revokes the winning family while other devices remain live`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const other = await f.seedSession();
    const first = await f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7");
    const claims = JSON.parse(Buffer.from(first.accessToken.split(".")[1]!, "base64url").toString()) as { jti: string };
    assert.equal(await f.store.isSessionRevoked(claims.jti), false);
    await assert.rejects(f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7"), IdentityAuthenticationError);
    assert.equal(await f.store.isSessionRevoked(claims.jti), true);
    assert.equal(await f.store.findIdentityRefreshSession({ refreshHash: refreshDigest(first.refreshToken) }), null);
    await assert.rejects(f.service.refresh({ refreshToken: first.refreshToken }, "192.0.2.7"), IdentityAuthenticationError);
    const independent = await f.service.refresh({ refreshToken: other.refreshToken }, "192.0.2.7");
    assert.equal(independent.tokenType, "Bearer");
    assert.equal((await f.refreshRows()).length, 2, "neither rejected replay creates another credential");
    assert.equal((await f.refreshRows(other.sessionId)).length, 2);
  });

  test(`${provider}: direct concurrent reuse is still one success, one refusal and family revocation`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const responses = await Promise.allSettled([f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7"), f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.8")]);
    const successes = responses.filter((result) => result.status === "fulfilled");
    const failures = responses.filter((result) => result.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(failures[0]!.reason instanceof IdentityAuthenticationError);
    const claims = JSON.parse(Buffer.from(successes[0]!.value.accessToken.split(".")[1]!, "base64url").toString()) as { jti: string };
    assert.equal(await f.store.isSessionRevoked(claims.jti), true);
    assert.equal((await f.refreshRows()).length, 2);
    const buckets = await f.buckets();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.attempts, 2);
  });

  test(`${provider}: revocation after quota lookup is rechecked by rotation, not treated as authenticated proof`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const service = createIdentityService({ env: f.env, store: { ...f.store, async findIdentityRefreshSession(input) {
      const metadata = await f.store.findIdentityRefreshSession(input);
      await f.store.revokeIdentityRefresh(input);
      return metadata;
    } } });
    await assert.rejects(service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7"), IdentityAuthenticationError);
    const rows = await f.refreshRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.used_at, null);
    assert.equal(await f.store.findIdentityRefreshSession({ refreshHash: f.initial.refreshHash }), null);
    assert.equal((await f.buckets())[0]!.key, f.rateKey("refresh:session", f.initial.sessionId));
  });

  test(`${provider}: an unspent token survives 429 and works once its durable fixed window expires`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    for (let attempt = 0; attempt < 120; attempt++) await f.store.consumeRateLimit({ key: f.rateKey("refresh:session", f.initial.sessionId), limit: 120, windowSeconds: 900 });
    await assert.rejects(f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7"), IdentityRateLimitError);
    assert.equal((await f.refreshRows())[0]!.used_at, null);
    await f.expireBuckets();
    const result = await f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7");
    assert.equal(result.tokenType, "Bearer");
    assert.notEqual(result.refreshToken, f.initial.refreshToken);
    assert.equal((await f.buckets()).length, 1);
    assert.equal((await f.buckets())[0]!.attempts, 1);
    assert.equal((await f.refreshRows()).length, 2);
  });

  test(`${provider}: the metadata port rejects malformed hashes and never returns token/account secrets`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    for (const value of ["", "a".repeat(63), "A".repeat(64), "x' OR 1=1 --", "a".repeat(65), f.initial.refreshToken]) assert.equal(await f.store.findIdentityRefreshSession({ refreshHash: value }), null);
    const result = await f.store.findIdentityRefreshSession({ refreshHash: f.initial.refreshHash });
    assert.deepEqual(result, { sessionId: f.initial.sessionId });
    assert.equal(JSON.stringify(result).includes(f.proof.passwordHash), false);
    assert.equal(JSON.stringify(result).includes(f.initial.refreshHash), false);
    assert.equal(JSON.stringify(result).includes(f.userId), false);
    assert.deepEqual(await f.buckets(), []);
    assert.equal((await f.refreshRows()).length, 1);
  });

  test(`${provider}: two contenders for the last quota slot cannot turn a 429 into reuse-family revocation`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const key = f.rateKey("refresh:session", f.initial.sessionId);
    for (let attempt = 0; attempt < 119; attempt++) await f.store.consumeRateLimit({ key, limit: 120, windowSeconds: 900 });
    const results = await Promise.allSettled([
      f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7"),
      f.service.refresh({ refreshToken: f.initial.refreshToken }, "2001:db8::7"),
    ]);
    const winner = results.find((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(winner && winner.status === "fulfilled");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof IdentityRateLimitError, "the over-budget request must stop before rotation");
    const claims = JSON.parse(Buffer.from(winner.value.accessToken.split(".")[1]!, "base64url").toString()) as { jti: string };
    assert.equal(await f.store.isSessionRevoked(claims.jti), false);
    assert.equal((await f.refreshRows()).length, 2);
    assert.equal((await f.refreshRows()).filter(({ used_at }) => used_at === null).length, 1);
    assert.equal((await f.buckets()).length, 1);
    assert.equal((await f.buckets())[0]!.attempts, 121);
    assert.deepEqual(await f.store.findIdentityRefreshSession({ refreshHash: refreshDigest(winner.value.refreshToken) }), { sessionId: f.initial.sessionId });
    await f.expireBuckets();
    const next = await f.service.refresh({ refreshToken: winner.value.refreshToken }, "198.51.100.7");
    assert.equal(next.tokenType, "Bearer");
    assert.equal((await f.refreshRows()).length, 3);
  });

  test(`${provider}: session-based refresh does not broaden the independent logout address budget`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const key = f.rateKey("logout:ip", "192.0.2.7");
    for (let attempt = 0; attempt < 120; attempt++) await f.store.consumeRateLimit({ key, limit: 120, windowSeconds: 900 });
    await assert.rejects(f.service.logout({ refreshToken: f.initial.refreshToken }, "192.0.2.7"), IdentityRateLimitError);
    assert.deepEqual(await f.store.findIdentityRefreshSession({ refreshHash: f.initial.refreshHash }), { sessionId: f.initial.sessionId });
    const renewed = await f.service.refresh({ refreshToken: f.initial.refreshToken }, "192.0.2.7");
    assert.equal(renewed.tokenType, "Bearer");
    assert.equal((await f.buckets()).length, 2);
    assert.equal((await f.buckets()).find((bucket) => bucket.key === key)!.attempts, 121);
    assert.equal((await f.buckets()).find((bucket) => bucket.key === f.rateKey("refresh:session", f.initial.sessionId))!.attempts, 1);
    assert.deepEqual(await f.service.logout({ refreshToken: renewed.refreshToken }, "192.0.2.8"), { ok: true });
    assert.equal(await f.store.findIdentityRefreshSession({ refreshHash: refreshDigest(renewed.refreshToken) }), null);
    assert.equal((await f.buckets()).length, 3);
    assert.equal((await f.buckets()).find((bucket) => bucket.key === f.rateKey("logout:ip", "192.0.2.8"))!.attempts, 1);
  });
}
