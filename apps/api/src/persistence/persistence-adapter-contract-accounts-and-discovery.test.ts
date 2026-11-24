/**
 * Recovery tokens, sessions and devices, publishing, the following feed, search, the author directory, roles and the featured shelf.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { MAX_ARTICLE_OFFSET, MAX_ARTICLE_OFFSET_POPULAR } from "../domain/article.ts";
import { ArticleInputError, ArticleSlugConflictError, IdempotencyConflictError, ProfileInputError } from "../domain/errors.ts";
import { registerForEngines, registerPostgresStore } from "./test-support/persistence-adapter-contract-fixtures.ts";

registerPostgresStore();

function registerAccountAndDiscoveryContracts(adapterName, fixture, options = {}) {
  test(`${adapterName}: recovery and verification tokens are single-use, purpose-scoped and expire`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userId = `identity-user-${suffix}`;
    const email = `identity-${suffix}@example.test`;
        // Keyed digests, derived from this run's suffix: a fixed literal would
    // collide on its primary key the second time this suite runs against the
    // same database, failing a test that has nothing to do with reruns.
    const tokenHash = (label: string) => createHash("sha256").update(`${suffix}:${label}`).digest("hex");
const hour = new Date(Date.now() + 3_600_000).toISOString();
    const session = {
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: tokenHash("a"), expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentityAccount({ userId, email, passwordHash: "hash-before", session }), true);
    // A second device, so a revocation can be asked to spare one of two.
    const secondSession = {
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: tokenHash("0"), expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentitySession(secondSession, { email, passwordHash: "hash-before" }), true);

    const resetHash = tokenHash("b");
    await runtime.store.issueIdentityToken({ userId, purpose: "password_reset", email, tokenHash: resetHash, expiresAt: hour });
    assert.equal(await runtime.store.consumeIdentityToken({ tokenHash: resetHash, purpose: "email_verification" }), null,
      "a reset link must not be redeemable as a verification link");
    assert.deepEqual(await runtime.store.consumeIdentityToken({ tokenHash: resetHash, purpose: "password_reset" }), { userId, email });
    assert.equal(await runtime.store.consumeIdentityToken({ tokenHash: resetHash, purpose: "password_reset" }), null,
      "the link works exactly once");

    const expiredHash = tokenHash("c");
    await runtime.store.issueIdentityToken({ userId, purpose: "password_reset", email, tokenHash: expiredHash, expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(await runtime.store.consumeIdentityToken({ tokenHash: expiredHash, purpose: "password_reset" }), null);

    // Issuing again supersedes the link that is already out: two live recovery
    // links is a support problem and doubles what a phished mailbox exposes.
    const superseded = tokenHash("d");
    const replacement = tokenHash("e");
    await runtime.store.issueIdentityToken({ userId, purpose: "email_verification", email, tokenHash: superseded, expiresAt: hour });
    await runtime.store.issueIdentityToken({ userId, purpose: "email_verification", email, tokenHash: replacement, expiresAt: hour });
    assert.equal(await runtime.store.consumeIdentityToken({ tokenHash: superseded, purpose: "email_verification" }), null);
    assert.ok(await runtime.store.consumeIdentityToken({ tokenHash: replacement, purpose: "email_verification" }));

    // The credential and the sign-out are one operation, so there is no
    // observable moment with the new credential and the old sessions alive.
    const changed = await runtime.store.replaceIdentityPassword({
      userId, passwordHash: "hash-after", exceptSessionId: session.sessionId,
    });
    assert.equal(changed.updated, true);
    // A password *change* is made from inside a session and spares it: two
    // live sessions, one named, so exactly the other one ends.
    assert.equal(changed.revokedSessions, 1, "the session that made the change keeps its own");
    assert.equal((await runtime.store.findIdentityAccount({ email })).passwordHash, "hash-after");

    const rotated = await runtime.store.rotateIdentityRefresh({
      refreshHash: tokenHash("a"), nextRefreshHash: tokenHash("f"),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(rotated.status, "rotated", "the spared device keeps its refresh family");
    // The second device was live too — it was signed out, not already dead.
    const signedOut = await runtime.store.rotateIdentityRefresh({
      refreshHash: tokenHash("0"), nextRefreshHash: tokenHash("1"),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(signedOut.status, "invalid", "every other device is signed out");

    // A reset has no device that proved anything, so it spares nothing.
    const reset = await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-final", exceptSessionId: null });
    assert.equal(reset.updated, true);
    assert.equal(reset.revokedSessions, 1, "a reset ends the session the owner was using too");
    assert.equal(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-final-2", exceptSessionId: null }).then((r) => r.revokedSessions), 0,
      "a second sweep finds nothing left to revoke");
    const afterRevocation = await runtime.store.rotateIdentityRefresh({
      refreshHash: tokenHash("f"), nextRefreshHash: tokenHash("2"),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(afterRevocation.status, "invalid", "a revoked session must not rotate");

    await runtime.store.markIdentityEmailVerified({ userId, verifiedAt: new Date().toISOString() });
    const account = await runtime.store.findIdentityAccountByUserId({ userId });
    assert.equal(account.email, email);
    assert.ok(account.emailVerifiedAt, "verification is stamped on the account");
    assert.equal(await runtime.store.findIdentityAccountByUserId({ userId: `nobody-${suffix}` }), null);
    // The credential has an accessor of its own, so the account record a
    // caller may forward to a response never carries the hash with it.
    assert.deepEqual(await runtime.store.findIdentityCredentials({ userId }), { userId, passwordHash: "hash-final-2" });
    assert.equal(await runtime.store.findIdentityCredentials({ userId: `nobody-${suffix}` }), null);

    /**
     * Moving an account to another address.
     *
     * Two properties, and the second is the one that has to be settled by the
     * database: the proof on file was for the *old* address, so it goes; and one
     * address cannot end up on two accounts, however close together two callers
     * ask for it.
     */
    const movedEmail = `identity-moved-${suffix}@example.test`;
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: movedEmail }), true);
    const moved = await runtime.store.findIdentityAccountByUserId({ userId });
    assert.equal(moved.email, movedEmail);
    assert.equal(moved.emailVerifiedAt, null, "proof of the old address is not proof of the new one");

    const otherUserId = `identity-other-${suffix}`;
    const otherEmail = `identity-other-${suffix}@example.test`;
    const otherSession = {
      sessionId: randomUUID(), userId: otherUserId, accessTokenId: randomUUID(),
      refreshHash: tokenHash("5"), expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentityAccount({
      userId: otherUserId, email: otherEmail, passwordHash: "hash-other", session: otherSession,
    }), true);
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: otherEmail }), false,
      "one address cannot belong to two accounts");
    assert.equal((await runtime.store.findIdentityAccountByUserId({ userId })).email, movedEmail,
      "a refused move must leave the account where it was");
    assert.equal(await runtime.store.setIdentityEmail({ userId: `nobody-${suffix}`, email: `nowhere-${suffix}@example.test` }), false,
      "an account that does not exist cannot be moved either");
  });

  test(`${adapterName}: a session requires the current account and the verified credentials`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID(), userId = `identity-login-${suffix}`, email = `identity-login-${suffix}@example.test`;
    const expiry = new Date(Date.now() + 3_600_000).toISOString();
    const makeSession = () => ({ userId, sessionId: randomUUID(), accessTokenId: randomUUID(),
      refreshHash: randomBytes(32).toString("hex"), expiresAt: expiry, accessExpiresAt: expiry });
    const registered = makeSession(), late = makeSession();
    const oldProof = { email, passwordHash: "fixture-before" };
    assert.equal(await runtime.store.createIdentityAccount({ userId, ...oldProof, session: registered }), true);
    for (const proof of [undefined, null, { email }, { ...oldProof, email: `wrong-${email}` }, { ...oldProof, passwordHash: "wrong" }]) {
      assert.equal(await runtime.store.createIdentitySession(late, proof), false);
    }
    assert.equal(await runtime.store.createIdentitySession({ ...late, userId: `missing-${suffix}` }, oldProof), false);
    assert.equal(await runtime.store.createIdentitySession(late, oldProof), true);
    assert.deepEqual(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "fixture-after" }), { updated: true, revokedSessions: 2 });
    const afterPassword = makeSession(), newProof = { email, passwordHash: "fixture-after" };
    assert.equal(await runtime.store.createIdentitySession(afterPassword, oldProof), false);
    assert.equal(await runtime.store.createIdentitySession(afterPassword, newProof), true);
    const moved = `moved-${email}`, afterEmail = makeSession();
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: moved }), true);
    assert.equal(await runtime.store.createIdentitySession(afterEmail, newProof), false);
    assert.equal(await runtime.store.createIdentitySession(afterEmail, { ...newProof, email: moved }), true);
    assert.deepEqual((await runtime.store.listIdentitySessions({ userId, limit: 50 })).map((s) => s.sessionId).sort(),
      [afterPassword.sessionId, afterEmail.sessionId].sort());
  });

  test(`${adapterName}: a signed-in change is refused once its proof no longer matches`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID(), userId = `identity-proof-${suffix}`, email = `identity-proof-${suffix}@example.test`;
    const expiry = new Date(Date.now() + 3_600_000).toISOString();
    const makeSession = () => ({ userId, sessionId: randomUUID(), accessTokenId: randomUUID(),
      refreshHash: randomBytes(32).toString("hex"), expiresAt: expiry, accessExpiresAt: expiry });
    const first = makeSession();
    assert.equal(await runtime.store.createIdentityAccount({ userId, email, passwordHash: "hash-before", session: first }), true);
    const verified = { email, passwordHash: "hash-before" }, stale = { ...verified, passwordHash: "hash-superseded" };
    // A proof for an account that never had these facts is refused, including
    // one for an address this account no longer (or never did) hold.
    assert.deepEqual(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-from-stale", proof: stale }), { updated: false, revokedSessions: 0 });
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: `stale-${email}`, proof: { ...verified, email: `old-${email}` } }), false);
    assert.equal(await runtime.store.setIdentityEmail({ userId: `missing-${suffix}`, email: `nowhere-${suffix}@example.test`, proof: verified }), false);
    assert.equal((await runtime.store.findIdentityAccountByUserId({ userId }))?.email, email, "a refused move leaves the address alone");
    assert.deepEqual((await runtime.store.findIdentityCredentials({ userId }))?.passwordHash, "hash-before");
    // The reset lands, as it would between the verification and the stale write.
    assert.deepEqual(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-reset" }), { updated: true, revokedSessions: 1 });
    const afterReset = makeSession();
    assert.equal(await runtime.store.createIdentitySession(afterReset, { email, passwordHash: "hash-reset" }), true);
    assert.deepEqual(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-stale", exceptSessionId: afterReset.sessionId, proof: verified }),
      { updated: false, revokedSessions: 0 }, "the older verified password cannot be written over the reset");
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: `stale-${email}`, proof: verified }), false,
      "nor can the address move on a proof the reset invalidated");
    assert.equal((await runtime.store.findIdentityCredentials({ userId }))?.passwordHash, "hash-reset");
    assert.equal((await runtime.store.findIdentityAccountByUserId({ userId }))?.email, email);
    assert.deepEqual((await runtime.store.listIdentitySessions({ userId, limit: 50 })).map((s) => s.sessionId), [afterReset.sessionId],
      "the refused change revokes nothing");
    // The current state is accepted, so the guard is not simply refusing.
    assert.deepEqual(await runtime.store.replaceIdentityPassword({
      userId, passwordHash: "hash-next", exceptSessionId: afterReset.sessionId, proof: { email, passwordHash: "hash-reset" },
    }), { updated: true, revokedSessions: 0 });
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: `moved-${email}`, proof: { email, passwordHash: "hash-next" } }), true);
  });

  test(`${adapterName}: a password replacement that cannot be written leaves every session as it was`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userId = `identity-user-${suffix}`;
    const email = `identity-${suffix}@example.test`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    // Random, not spelled out: the PostgreSQL half of this file runs against one
    // shared database, and a refresh hash is a primary key.
    const hash = () => randomBytes(32).toString("hex");
    const thisRefresh = hash();
    const otherRefresh = hash();
    const session = {
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: thisRefresh, expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentityAccount({ userId, email, passwordHash: "hash-before", session }), true);
    const secondSession = {
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: otherRefresh, expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentitySession(secondSession, { email, passwordHash: "hash-before" }), true);

    /**
     * The point of the whole method: the sessions and the credential are two
     * statements that must never be observable apart. If the write cannot
     * happen, everything the call did has to come back — otherwise the failure
     * looks like "the password did not change" while quietly having signed the
     * owner's other devices out.
     *
     * `password_hash` is NOT NULL in both providers, so this is the one way a
     * test can make the write fail the same way on both.
     */
    await assert.rejects(() => runtime.store.replaceIdentityPassword({
      userId, passwordHash: null as unknown as string, exceptSessionId: session.sessionId,
    }));

    assert.equal((await runtime.store.findIdentityAccount({ email })).passwordHash, "hash-before",
      "a failed replacement leaves the old credential in place");
    const otherDevice = await runtime.store.rotateIdentityRefresh({
      refreshHash: otherRefresh, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(otherDevice.status, "rotated", "and the sessions it would have revoked are still signed in");
    const thisDevice = await runtime.store.rotateIdentityRefresh({
      refreshHash: thisRefresh, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(thisDevice.status, "rotated", "the session that would have been spared never notices");

    /**
     * Naming a session that is not this account's spares nothing. The sparing is
     * a filter on the account's own sessions, so a session id taken from
     * somewhere else cannot keep this account's thief signed in.
     */
    const otherUserId = `identity-other-${suffix}`;
    const foreignRefresh = hash();
    const otherSession = {
      sessionId: randomUUID(), userId: otherUserId, accessTokenId: randomUUID(),
      refreshHash: foreignRefresh, expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentityAccount({
      userId: otherUserId, email: `identity-other-${suffix}@example.test`, passwordHash: "hash-other", session: otherSession,
    }), true);
    const foreign = await runtime.store.replaceIdentityPassword({
      userId, passwordHash: "hash-after", exceptSessionId: otherSession.sessionId,
    });
    assert.equal(foreign.revokedSessions, 2, "a session that is not this account's spares none of its sessions");
    const foreignSession = await runtime.store.rotateIdentityRefresh({
      refreshHash: foreignRefresh, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(foreignSession.status, "rotated", "and the other account is untouched by it");
  });

  test(`${adapterName}: a device can be listed, ended on its own, and ended along with the others`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userId = `identity-user-${suffix}`;
    const email = `identity-${suffix}@example.test`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    const hash = () => randomBytes(32).toString("hex");
    const makeSession = () => ({
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: hash(), expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const phone = makeSession();
    const laptop = makeSession();
    assert.equal(await runtime.store.createIdentityAccount({ userId, email, passwordHash: "hash-before", session: phone }), true);
    assert.equal(await runtime.store.createIdentitySession(laptop, { email, passwordHash: "hash-before" }), true);
    // A session that already expired is not a device anybody can be asked about.
    assert.equal(await runtime.store.createIdentitySession({ ...makeSession(), expiresAt: new Date(Date.now() - 1000).toISOString() }, { email, passwordHash: "hash-before" }), true);

    const listed = await runtime.store.listIdentitySessions({ userId, limit: 50 });
    assert.deepEqual(listed.map((session) => session.sessionId).sort(), [phone.sessionId, laptop.sessionId].sort(),
      "only live sessions are devices; the expired one is not offered as a choice");
    for (const session of listed) {
      assert.equal(session.lastUsedAt, null, "nothing has refreshed yet");
      assert.ok(new Date(session.expiresAt).getTime() > Date.now());
      assert.ok(new Date(session.createdAt).getTime() <= Date.now());
    }

    // Refreshing is the only activity the store can honestly report.
    const rotated = await runtime.store.rotateIdentityRefresh({
      refreshHash: phone.refreshHash, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(rotated.status, "rotated");
    const afterUse = await runtime.store.listIdentitySessions({ userId, limit: 50 });
    const used = afterUse.find((session) => session.sessionId === phone.sessionId);
    assert.ok(used?.lastUsedAt, "the device that refreshed shows when");
    assert.equal(afterUse.length, 2, "and it is still the same two devices");
    assert.equal(afterUse[0]?.sessionId, phone.sessionId, "newest activity first");

    // Ending one device: exactly that one stops working.
    assert.equal(await runtime.store.revokeIdentitySession({ userId, sessionId: laptop.sessionId }), true);
    assert.equal(await runtime.store.revokeIdentitySession({ userId, sessionId: laptop.sessionId }), false,
      "ending it twice is not a second device");
    assert.equal(await runtime.store.revokeIdentitySession({ userId, sessionId: randomUUID() }), false,
      "an id that is not a session of this account is not ended");
    const laptopAfter = await runtime.store.rotateIdentityRefresh({
      refreshHash: laptop.refreshHash, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(laptopAfter.status, "invalid", "the ended device cannot refresh");
    const listedAfter = await runtime.store.listIdentitySessions({ userId, limit: 50 });
    assert.deepEqual(listedAfter.map((session) => session.sessionId), [phone.sessionId]);

    // Ending every other device keeps the one that asked.
    const third = makeSession();
    assert.equal(await runtime.store.createIdentitySession(third, { email, passwordHash: "hash-before" }), true);
    assert.equal(await runtime.store.revokeIdentitySessions({ userId, exceptSessionId: phone.sessionId }), 1,
      "the new device goes, the one that asked stays");
    const thirdAfter = await runtime.store.rotateIdentityRefresh({
      refreshHash: third.refreshHash, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(thirdAfter.status, "invalid");
    assert.equal(await runtime.store.revokeIdentitySessions({ userId, exceptSessionId: phone.sessionId }), 0,
      "a second sweep finds nothing left to end");

    // Sparing nothing ends the device that asked too.
    assert.equal(await runtime.store.revokeIdentitySessions({ userId, exceptSessionId: null }), 1);
    assert.deepEqual(await runtime.store.listIdentitySessions({ userId, limit: 50 }), []);

    // The list is bounded, because it is rendered as a choice.
    for (let index = 0; index < 3; index += 1) assert.equal(await runtime.store.createIdentitySession(makeSession(), { email, passwordHash: "hash-before" }), true);
    assert.equal((await runtime.store.listIdentitySessions({ userId, limit: 2 })).length, 2);
    // ...and another account's devices are never in it.
    const otherUserId = `identity-other-${suffix}`;
    assert.equal(await runtime.store.createIdentityAccount({
      userId: otherUserId, email: `identity-other-${suffix}@example.test`, passwordHash: "hash-other", session: makeSession(),
    }), true);
    assert.equal(await runtime.store.revokeIdentitySession({ userId, sessionId: phone.sessionId }), false,
      "an ended session is not a device of this account any more");
  });

  test(`${adapterName}: publishing a work is idempotent per author and does not leave a second copy behind`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const author = `article-author-${suffix}`;
    const other = `article-author-b-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Shared persistence contract content." }];
    const slug = `contract-create-once-${suffix}`;
    const input = {
      authorId: author, slug, requestedSlug: slug, title: "Create once", summary: "",
      locale: "zh-CN", contentBlocks: blocks, publish: true, idempotencyKey: `publish-once-${suffix}`,
    };
    try {
      // Three at once, not two: a single pair raced rarely enough that the
      // PostgreSQL half passed by luck locally and failed under CI's load, and
      // the failure it hides is either a duplicate work or a bogus slug conflict.
      const attempts = await Promise.all([
        runtime.store.createArticle(input),
        runtime.store.createArticle(input),
        runtime.store.createArticle(input),
      ]);
      const [first, retried] = attempts;
      assert.equal(new Set(attempts.map((article) => article.id)).size, 1, "concurrent retries must all return the one work");
      assert.equal(retried.id, first.id, "a retry must return the work the first attempt published");
      assert.equal(retried.slug, first.slug, "and must not have been handed a uniquified second address");
      assert.equal(
        (await runtime.store.listMyArticles({ actorId: author, locale: "zh-CN", limit: 100 })).filter((item) => item.id === first.id).length,
        1,
      );

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticle({ ...input, title: "A different work" })),
        IdempotencyConflictError,
        "the same key with a different work is a conflicting request, not a replay",
      );

      // Without a key the same address is simply taken: turning a genuinely
      // different work into a new address is the route's uniquifier, not the
      // store's, and a replay must not lean on it.
      const unkeyed = {
        ...input,
        idempotencyKey: null,
        slug: `contract-create-twice-${suffix}`,
        requestedSlug: `contract-create-twice-${suffix}`,
      };
      await runtime.store.createArticle(unkeyed);
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticle(unkeyed)),
        ArticleSlugConflictError,
      );

      // The key is scoped to the author: someone else may reuse the same string
      // for their own work.
      const theirs = await runtime.store.createArticle({
        ...input,
        authorId: other,
        slug: `contract-create-once-b-${suffix}`,
        requestedSlug: `contract-create-once-b-${suffix}`,
      });
      assert.notEqual(theirs.id, first.id);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: an auto-generated slug replay survives suffix uniquification`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const author = `article-author-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Auto slug replay contract content." }];
    try {
      // Draft and published writes must answer the same way: the bug was in the
      // request fingerprint, not in the status the article ended up with.
      for (const publish of [false, true]) {
        const base = `auto-slug-${publish ? "published" : "draft"}-${suffix}`;
        const key = `auto-slug-${publish ? "published" : "draft"}-key-${suffix}`;
        const common = {
          authorId: author, title: "Auto slug replay", summary: "", locale: "zh-CN",
          contentBlocks: blocks, publish, idempotencyKey: key, requestedSlug: null,
        };

        // The route's first attempt would hit a taken base slug; this call
        // stands in for the successful `-2` attempt.
        const first = await runtime.store.createArticle({ ...common, slug: `${base}-2` });
        assert.equal(first.slug, `${base}-2`);

        // A sequential replay starts again at the base candidate. It must still
        // return the one work that was actually stored.
        const replay = await runtime.store.createArticle({ ...common, slug: base });
        assert.equal(replay.id, first.id, "a sequential replay must return the first work");
        assert.equal(replay.slug, first.slug, "and must keep the suffix the first write committed");

        // Concurrent replays may arrive at different candidate slugs.
        const attempts = await Promise.all([
          runtime.store.createArticle({ ...common, slug: base }),
          runtime.store.createArticle({ ...common, slug: `${base}-2` }),
          runtime.store.createArticle({ ...common, slug: `${base}-3` }),
        ]);
        assert.equal(new Set(attempts.map((article) => article.id)).size, 1);
        assert.equal(attempts[0].slug, first.slug);

        // A client-supplied slug is part of the fingerprint: reusing the key
        // with a different explicit address is still a conflict.
        await assert.rejects(
          Promise.resolve().then(() => runtime.store.createArticle({
            ...common,
            slug: `${base}-explicit`,
            requestedSlug: `${base}-explicit`,
          })),
          IdempotencyConflictError,
          "an explicit slug change must not be accepted as a replay",
        );
      }
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: the following feed lists published work from followed authors, newest first`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const readerId = `feed-reader-${suffix}`;
    const authorA = `feed-author-a-${suffix}`;
    const authorB = `feed-author-b-${suffix}`;
    const strangerId = `feed-stranger-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Feed contract body." }];
    try {
      for (const [userId, displayName] of [[authorA, "Feed A"], [authorB, "Feed B"], [strangerId, "Stranger"]]) {
        await runtime.store.upsertAuthorProfile({ userId, displayName, locale: "zh-CN" });
      }
      await runtime.store.createArticle({ authorId: authorA, slug: `feed-older-${suffix}`, title: "A 的旧作", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.store.createArticle({ authorId: authorA, slug: `feed-draft-${suffix}`, title: "A 的草稿", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: false });
      await runtime.store.createArticle({ authorId: authorB, slug: `feed-newer-${suffix}`, title: "B 的新作", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.store.createArticle({ authorId: strangerId, slug: `feed-unfollowed-${suffix}`, title: "陌生人的作品", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.setArticlePublishedAt(`feed-older-${suffix}`, "2024-01-01T00:00:00.000Z");
      await runtime.setArticlePublishedAt(`feed-newer-${suffix}`, "2024-06-01T00:00:00.000Z");

      // Following nobody is an empty feed, not an error and not the global feed.
      assert.deepEqual(await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN" }), []);

      assert.equal(await runtime.store.followUser({ actorId: readerId, targetUserId: authorA }), true);
      assert.equal(await runtime.store.followUser({ actorId: readerId, targetUserId: authorB }), true);

      const feed = await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN" });
      assert.deepEqual(feed.map((article) => article.slug), [`feed-newer-${suffix}`, `feed-older-${suffix}`]);
      // A draft the followed author has not published is not an update yet.
      assert.ok(!feed.some((article) => article.slug === `feed-draft-${suffix}`));
      assert.ok(!feed.some((article) => article.authorId === strangerId));

      // Locale is a property of the translation the reader asked for, not of the author.
      assert.deepEqual(await runtime.store.listFollowingArticles({ actorId: readerId, locale: "en" }), []);

      // Offset pagination walks the same set once, without repeats or gaps.
      const firstPage = await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 1, offset: 0 });
      const secondPage = await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 1, offset: 1 });
      const thirdPage = await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 1, offset: 2 });
      assert.deepEqual(firstPage.map((article) => article.slug), [`feed-newer-${suffix}`]);
      assert.deepEqual(secondPage.map((article) => article.slug), [`feed-older-${suffix}`]);
      assert.deepEqual(thirdPage, []);

      // Unfollowing removes the author's work from the feed immediately.
      await runtime.store.unfollowUser({ actorId: readerId, targetUserId: authorA });
      assert.deepEqual(
        (await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN" })).map((article) => article.slug),
        [`feed-newer-${suffix}`],
      );

      // The same bounds as every other article list, so a client page size cannot
      // become an unbounded scan.
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 0 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 101 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", offset: -1 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", offset: 100001 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: "  ", locale: "zh-CN" })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "klingon" })), ArticleInputError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: discovery sorts by newest, or by how many times a work was ever saved`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `sort-author-${suffix}`;
    const otherAuthorId = `sort-other-author-${suffix}`;
    const now = new Date("2026-06-01T00:00:00.000Z");
    const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
    const blocks = [{ id: "p1", type: "paragraph", text: "Sort contract body." }];
    const publish = async (author, slug, title, days) => {
      // The title carries the suffix so every query below can scope itself to the
      // rows this test owns: the PostgreSQL fixture is one shared database, unlike
      // SQLite's per-test `:memory:` file, so an unscoped list assertion would read
      // whatever another contract left behind.
      await runtime.store.createArticle({ authorId: author, slug, title: `${title}-${suffix}`, summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.setArticlePublishedAt(slug, daysAgo(days));
    };
    const like = async (slug, howMany) => {
      for (let index = 1; index <= howMany; index += 1) {
        await runtime.store.setArticleLike({ slug, locale: "zh-CN", actorId: `sort-liker-${suffix}-${index}`, liked: true });
      }
    };
    try {
      await runtime.store.upsertAuthorProfile({ userId: authorId, displayName: "Sort Author", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: otherAuthorId, displayName: "Other Author", locale: "zh-CN" });
      await publish(authorId, `sort-quiet-${suffix}`, "安静的新作", 1);
      await publish(authorId, `sort-popular-${suffix}`, "寻找春天", 3);
      await publish(authorId, `sort-edge-in-${suffix}`, "刚好在窗口内", 30);
      await publish(authorId, `sort-edge-out-${suffix}`, "刚好在窗口外", 31);
      await publish(authorId, `sort-old-${suffix}`, "两年前的旧作", 60);
      await publish(otherAuthorId, `sort-other-work-${suffix}`, "别人的作品", 2);
      // Nothing is excluded for being old: the tab is "most saved", so a work
      // that collected its likes two years ago outranks one published yesterday.
      await like(`sort-edge-out-${suffix}`, 10);
      await like(`sort-old-${suffix}`, 5);
      await like(`sort-popular-${suffix}`, 3);

      const slugs = (articles) => articles.map((article) => article.slug);
      const latest = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, limit: 20 });
      assert.deepEqual(slugs(latest), [
        `sort-quiet-${suffix}`, `sort-other-work-${suffix}`, `sort-popular-${suffix}`,
        `sort-edge-in-${suffix}`, `sort-edge-out-${suffix}`, `sort-old-${suffix}`,
      ]);

      // Every save the work ever had, then newest first to break a tie. The
      // two-year-old piece with 5 saves sits above yesterday's quiet new work.
      const popular = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 20 });
      assert.deepEqual(slugs(popular), [
        `sort-edge-out-${suffix}`, `sort-old-${suffix}`, `sort-popular-${suffix}`,
        `sort-quiet-${suffix}`, `sort-other-work-${suffix}`, `sort-edge-in-${suffix}`,
      ]);

      const tail = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 20, offset: 3 });
      assert.deepEqual(slugs(tail), [`sort-quiet-${suffix}`, `sort-other-work-${suffix}`, `sort-edge-in-${suffix}`]);

      // Sort composes with the existing filters instead of replacing them.
      const searched = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: `春天-${suffix}`, sort: "popular", limit: 20 });
      assert.deepEqual(slugs(searched), [`sort-popular-${suffix}`]);
      const byAuthor = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, authorId, sort: "popular", limit: 20 });
      assert.deepEqual(slugs(byAuthor), [
        `sort-edge-out-${suffix}`, `sort-old-${suffix}`, `sort-popular-${suffix}`,
        `sort-quiet-${suffix}`, `sort-edge-in-${suffix}`,
      ]);

      // Pagination walks the sorted set once.
      const firstTwo = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 2, offset: 0 });
      const nextTwo = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 2, offset: 2 });
      const lastTwo = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 2, offset: 4 });
      assert.deepEqual(slugs(firstTwo).concat(slugs(nextTwo), slugs(lastTwo)), slugs(popular));

      await assert.rejects(Promise.resolve().then(() => runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "hottest" })), ArticleInputError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  /**
   * A reader who remembers one line of a story has no title to search for. The
   * body is therefore searched too — block by block, and never as the JSON it is
   * stored as, because matching the raw text would make "paragraph" the most
   * successful query on the site.
   *
   * "One line" is not always a paragraph: it can be a bullet or a line of code
   * (#245). Both engines search every field a reader wrote, and neither searches
   * the block vocabulary.
   */
  test(`${adapterName}: a search finds a work by a word that appears only in its body`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `search-author-${suffix}`;
    const blocks = (text) => [{ id: "p1", type: "paragraph", text }];
    const publish = async (slug, title, summary, text) => {
      await runtime.store.createArticle({ authorId, slug, title, summary, locale: "zh-CN", contentBlocks: blocks(text), publish: true });
    };
    try {
      await runtime.store.upsertAuthorProfile({ userId: authorId, displayName: "Search Author", locale: "zh-CN" });
      await publish(`search-in-title-${suffix}`, `雨-${suffix}`, `雨的摘要-${suffix}`, "正文里没有那个字。");
      await publish(`search-in-body-${suffix}`, `无题-${suffix}`, `平淡的摘要-${suffix}`, "她把书翻到第七十页，窗外正下着雨。");
      await publish(`search-absent-${suffix}`, `别的-${suffix}`, `别的摘要-${suffix}`, "完全无关的一段正文。");
      // The word is in the *second* block, so a body search that stops at the
      // first block it reads would miss it.
      await runtime.store.createArticle({
        authorId,
        slug: `search-later-block-${suffix}`,
        title: `两段-${suffix}`,
        summary: `两段的摘要-${suffix}`,
        locale: "zh-CN",
        contentBlocks: [
          { id: "p1", type: "paragraph", text: "第一段里没有那个字。" },
          { id: "p2", type: "paragraph", text: "第二段写着：雨停了。" },
        ],
        publish: true,
      });

      const slugs = (articles) => articles.map((article) => article.slug).sort();
      const byWord = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "雨", limit: 50 });
      assert.deepEqual(
        slugs(byWord),
        [`search-in-body-${suffix}`, `search-in-title-${suffix}`, `search-later-block-${suffix}`].sort(),
      );

      // The body adds hits; it does not replace the fields that were already
      // searched, and it is not searched at the cost of them.
      const bySummary = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: `雨的摘要-${suffix}`, limit: 50 });
      assert.deepEqual(slugs(bySummary), [`search-in-title-${suffix}`]);

      // A list's items and a code block's code are text the reader wrote (#245),
      // and on a technical site they are often the only place a term appears.
      await runtime.store.createArticle({
        authorId,
        slug: `search-list-code-${suffix}`,
        title: `代码与清单-${suffix}`,
        summary: `技术笔记的摘要-${suffix}`,
        locale: "zh-CN",
        contentBlocks: [
          { id: "l1", type: "list", ordered: false, items: ["列表独有词条阿尔法"] },
          { id: "c1", type: "code", language: "ts", code: "const uniqueCodeTokenBeta = 1;" },
        ],
        publish: true,
      });
      const byListItem = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "阿尔法", limit: 50 });
      assert.deepEqual(slugs(byListItem), [`search-list-code-${suffix}`], "a list item is body text");
      // The needle is folded by the engine, so the same hit is found in any case.
      const byCode = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "uniquecodetokenbeta", limit: 50 });
      assert.deepEqual(slugs(byCode), [`search-list-code-${suffix}`], "so is a line of code");

      // Storage is not content: a block's own vocabulary is not findable.
      assert.deepEqual(await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "paragraph", limit: 50 }), []);
      assert.deepEqual(await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "ordered", limit: 50 }), []);

      // The body search composes with what surrounds it.
      const scoped = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "雨", authorId, sort: "popular", limit: 50 });
      assert.deepEqual(
        slugs(scoped),
        [`search-in-body-${suffix}`, `search-in-title-${suffix}`, `search-later-block-${suffix}`].sort(),
      );
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  /**
   * The two orders have different ceilings, and the store enforces the same one
   * the route applies (audit F-23).
   *
   * `latest` can be walked exactly by a cursor, so a deep `OFFSET` is merely
   * expensive. `popular` orders by a count that changes as it is read, so there
   * is no cursor to fall back on and the honest answer past the ceiling is a
   * refusal rather than a page that may be wrong before it is rendered.
   */
  test(`${adapterName}: the most-saved order is not pageable past its ceiling`, options, async () => {
    const runtime = await fixture();
    const suffix = `offset-ceiling-${randomUUID().slice(0, 8)}`;
    try {
      await assert.rejects(
        Promise.resolve().then(() =>
          runtime.store.listPublishedArticles({ locale: "zh-CN", sort: "popular", offset: MAX_ARTICLE_OFFSET_POPULAR + 1 }),
        ),
        (error) => error instanceof ArticleInputError && /sort=popular/.test(error.message),
      );
      // The same depth is allowed newest-first, and the newest-first ceiling is
      // still the one the transport publishes.
      assert.deepEqual(await runtime.store.listPublishedArticles({ locale: "zh-CN", offset: MAX_ARTICLE_OFFSET_POPULAR + 1 }), []);
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listPublishedArticles({ locale: "zh-CN", offset: MAX_ARTICLE_OFFSET + 1 })),
        ArticleInputError,
      );
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  /**
   * Why a cursor exists: an offset counts rows, so a work published while the
   * reader is scrolling pushes everything down and they meet one twice. A
   * cursor names the last work they saw instead, so the answer does not depend
   * on what happened above it.
   *
   * The test publishes a new work between the two reads, which is the whole
   * point — and then asks the same question by offset to show the difference.
   */
  /**
   * The public author directory (ADR 0024).
   *
   * The assertions that matter are the ones a reader can see and the ones a
   * directory has to get right to be worth publishing:
   *
   * - **only authors a reader can go and read** — somebody who has published in
   *   this locale. An account with no work is not an author here, and listing
   *   one would turn the directory into a member list;
   * - **works counted in the requested locale only** — a draft, a tombstone and
   *   another locale's work are all published-elsewhere, not published-here;
   * - **relevance before reach** — searching a name puts the name that *starts*
   *   with the term above the name that merely contains it, even when the second
   *   author has more followers; with no term at all, reach is the order, because
   *   the point of a directory is discovery.
   */
  test(`${adapterName}: the author directory lists published authors of this locale, relevance first`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID().slice(0, 8);
    const prefixId = `dir-prefix-${suffix}`;
    const containsId = `dir-contains-${suffix}`;
    const englishId = `dir-english-${suffix}`;
    const silentId = `dir-silent-${suffix}`;
    const followerId = `dir-follower-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "A published body." }];
    const publish = (authorId, slug, locale = "zh-CN") =>
      runtime.store.createArticle({ authorId, slug, title: slug, summary: "", locale, contentBlocks: blocks, publish: true });
    const names = (rows) => rows.map((row) => row.displayName);
    const byId = (rows, userId) => rows.find((row) => row.userId === userId);
    try {
      await runtime.store.upsertAuthorProfile({ userId: prefixId, displayName: `林晚 ${suffix}`, bio: "写小说", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: containsId, displayName: `苏林 ${suffix}`, bio: "写诗", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: englishId, displayName: `English Only ${suffix}`, locale: "en" });
      await runtime.store.upsertAuthorProfile({ userId: silentId, displayName: `没有作品 ${suffix}`, locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: followerId, displayName: `Follower ${suffix}`, locale: "zh-CN" });

      // 林晚: two published Chinese works, plus a draft and a tombstone that must
      // not be counted, and an English work that belongs to the other locale.
      await publish(prefixId, `dir-prefix-1-${suffix}`);
      await publish(prefixId, `dir-prefix-2-${suffix}`);
      await runtime.store.createArticle({ authorId: prefixId, slug: `dir-prefix-draft-${suffix}`, title: "草稿", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: false });
      const doomed = await runtime.store.createArticle({ authorId: prefixId, slug: `dir-prefix-gone-${suffix}`, title: "回收站", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.store.deleteArticle({ articleId: doomed.id, actorId: prefixId });
      await publish(prefixId, `dir-prefix-en-${suffix}`, "en");
      await publish(containsId, `dir-contains-1-${suffix}`);
      await publish(englishId, `dir-english-1-${suffix}`, "en");
      // 苏林 is the more-followed of the two: the ordering test only means
      // something if reach and relevance disagree.
      await runtime.store.followUser({ actorId: followerId, targetUserId: containsId });

      const directory = await runtime.store.searchAuthors({ locale: "zh-CN", limit: 50 });
      const ids = directory.map((row) => row.userId);
      assert.ok(ids.includes(prefixId), "an author with published work in this locale is listed");
      assert.ok(ids.includes(containsId));
      assert.equal(ids.includes(silentId), false, "an account that has published nothing is not an author here");
      assert.equal(ids.includes(englishId), false, "and neither is somebody who published only in another locale");
      assert.equal(byId(directory, prefixId).workCount, 2, "the draft, the tombstone and the English work are not counted");
      assert.equal(byId(directory, containsId).workCount, 1);
      assert.equal(byId(directory, prefixId).followerCount, 0);
      assert.equal(byId(directory, containsId).followerCount, 1);

      // No term: reach is the order.
      assert.equal(names(directory)[0], `苏林 ${suffix}`, "the author with more followers comes first");

      // With a term: relevance is the order, and it outranks reach.
      const searched = await runtime.store.searchAuthors({ locale: "zh-CN", query: "林", limit: 50 });
      assert.deepEqual(names(searched), [`林晚 ${suffix}`, `苏林 ${suffix}`], "a name that starts with the term beats one that only contains it");

      // The directory is locale-scoped, like every other public list: it is the
      // *works* that decide membership, not the language of the profile. 林晚 also
      // published in English, so 林晚 is in the English directory — under the only
      // name they have, which is the Chinese one. 苏林 did not, so 苏林 is not.
      const english = await runtime.store.searchAuthors({ locale: "en", limit: 50 });
      const englishIds = english.map((row) => row.userId);
      assert.ok(englishIds.includes(englishId), "the English author is in the English directory");
      assert.ok(englishIds.includes(prefixId), "and so is the Chinese author who published there too");
      assert.equal(englishIds.includes(containsId), false, "an author who published only in Chinese is not");

      // Paging is offset-based, like the category index it sits beside.
      assert.deepEqual(names(await runtime.store.searchAuthors({ locale: "zh-CN", limit: 1, offset: 0 })), [`苏林 ${suffix}`]);
      assert.deepEqual(names(await runtime.store.searchAuthors({ locale: "zh-CN", limit: 1, offset: 1 })), [`林晚 ${suffix}`]);
      assert.deepEqual(names(await runtime.store.searchAuthors({ locale: "zh-CN", limit: 1, offset: 2 })), [], "past the end is an empty page");

      // A name nobody has: empty, not everything.
      assert.deepEqual(await runtime.store.searchAuthors({ locale: "zh-CN", query: `no-such-author-${suffix}` }), []);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: the author directory refuses unbounded queries and pages`, options, async () => {
    const runtime = await fixture();
    const bad = [
      { query: "x".repeat(201) },
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 100_001 },
    ];
    for (const input of bad) {
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.searchAuthors({ locale: "zh-CN", ...input })),
        ProfileInputError,
        `rejects ${JSON.stringify(input)}`,
      );
    }
    // An empty query is not an invalid one: it is the whole directory.
    assert.ok(Array.isArray(await runtime.store.searchAuthors({ locale: "zh-CN", query: "", limit: 1 })));
  });
}

registerForEngines(registerAccountAndDiscoveryContracts);
