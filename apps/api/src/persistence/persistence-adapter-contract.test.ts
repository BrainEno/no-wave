/**
 * Accounts, messaging, the outbox and inbox, sessions and profiles, and work visibility.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_AUTHOR_DISPLAY_NAME } from "../domain/profile.ts";
import { ArticleInputError, ConversationInputError, IdempotencyConflictError, ConversationAccessError, ArticleAuthorizationError, ProfileInputError, ProfileNotFoundError } from "../domain/errors.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";
import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";
import { postgresSql, postgresStore, registerForEngines, registerPostgresStore } from "./test-support/persistence-adapter-contract-fixtures.ts";

registerPostgresStore();

function registerCoreAdapterContracts(adapterName, fixture, options = {}) {
  test(`${adapterName}: createIdentityAccount writes a default author profile in the same transaction`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userId = `identity-default-profile-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      const created = await runtime.store.createIdentityAccount({
        userId,
        email: `default-profile-${suffix}@example.test`,
        passwordHash: "hash-before",
        session: {
          sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "a").padEnd(64, "a"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      assert.equal(created, true);
      const profile = await runtime.store.getAuthorProfile({ userId, locale: "zh-CN", viewerId: null });
      assert.equal(profile?.displayName, DEFAULT_AUTHOR_DISPLAY_NAME);
      assert.equal(profile?.locale, "zh-CN");
      assert.equal(profile?.role, "member");
    } finally { await runtime.cleanup(null, suffix); }
  });

  test(`${adapterName}: message persistence is idempotent and rejects payload conflicts`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      const input = {
        conversationId,
        senderId: `sender-${suffix}`,
        body: "contract message",
        idempotencyKey: `key-${suffix}`,
      };
      const first = await runtime.store.persistMessage(input);
      const retry = await runtime.store.persistMessage(input);
      assert.equal(first.duplicate, false);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.id, first.id);
      await assert.rejects(
        runtime.store.persistMessage({ ...input, body: "conflicting payload" }),
        IdempotencyConflictError,
      );
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: message persistence denies non-participants without creating messages`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `member-${suffix}`,
        participantIds: [`other-${suffix}`],
      });
      conversationId = conversation.id;
      await assert.rejects(
        runtime.store.persistMessage({
          conversationId,
          senderId: `outsider-${suffix}`,
          body: "must not persist",
          idempotencyKey: `key-${suffix}`,
        }),
        ConversationAccessError,
      );
      const history = await runtime.store.listConversationMessages({
        conversationId,
        actorId: `member-${suffix}`,
        limit: 10,
      });
      assert.deepEqual(history, []);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: a successful outbox dispatch marks a persisted event delivered`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      const message = await runtime.store.persistMessage({
        conversationId,
        senderId: `sender-${suffix}`,
        body: "deliver through the shared worker",
        idempotencyKey: `key-${suffix}`,
      });
      const delivered = [];
      const result = await dispatchOutboxBatch({
        store: runtime.store,
        deliver: async (event) => delivered.push(event),
        limit: 10,
        leaseSeconds: 30,
      });
      assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0, deadLettered: 0 });
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].event_key, `message:${message.id}`);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: delivered[0].id, leaseToken: delivered[0].lease_token }), false);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 10 })).length, 0);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: the outbox backlog reports undelivered work and clears once delivered`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      // Compared as a delta: the shared PostgreSQL database can carry rows from
      // earlier tests, and this test is about the drain's own event.
      const before = await runtime.store.outboxBacklog();
      assert.ok(Number.isInteger(before.pendingEvents) && before.pendingEvents >= 0);
      assert.ok(before.oldestPendingAgeMs >= 0);

      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: `sender-${suffix}`, body: "counted in the backlog", idempotencyKey: `key-${suffix}`,
      });

      const pending = await runtime.store.outboxBacklog();
      assert.equal(pending.pendingEvents - before.pendingEvents, 1, "one persisted message queues exactly one event");

      const result = await dispatchOutboxBatch({
        store: runtime.store,
        deliver: async () => {},
        limit: 10,
      });
      assert.equal(result.delivered, 1);
      assert.equal((await runtime.store.outboxBacklog()).pendingEvents, before.pendingEvents);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: opening a conversation is idempotent per caller and rejects a reused key with different participants`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const creator = `contract-user-a-${suffix}`;
    const invited = `contract-user-b-${suffix}`;
    const third = `contract-user-c-${suffix}`;
    let conversationId = null;
    try {
      const input = { actorId: creator, participantIds: [invited], idempotencyKey: `open-once-${suffix}` };
      const [first, retried, thirdAttempt] = await Promise.all([
        runtime.store.createConversation(input),
        runtime.store.createConversation(input),
        runtime.store.createConversation(input),
      ]);
      conversationId = first.id;
      assert.equal(new Set([first.id, retried.id, thirdAttempt.id]).size, 1, "concurrent retries must all return the one conversation");
      assert.equal(retried.id, first.id, "a retry must return the conversation the first attempt opened, not a second one beside it");
      assert.equal(
        (await runtime.store.listConversations({ actorId: creator, limit: 100 })).filter((item) => item.id === first.id).length,
        1,
      );

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createConversation({ ...input, participantIds: [third] })),
        IdempotencyConflictError,
        "the same key with a different body is a conflicting request, not a replay",
      );

      // The key is scoped to the caller: another user may reuse the same string.
      const theirs = await runtime.store.createConversation({ actorId: invited, participantIds: [creator], idempotencyKey: `open-once-${suffix}` });
      assert.notEqual(theirs.id, first.id);

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createConversation({ actorId: creator, participantIds: [invited], idempotencyKey: " not trimmed " })),
        ConversationInputError,
      );

      // A replay answers with what the conversation is now, not with a frozen
      // copy of the 201 the first attempt would have returned.
      await runtime.store.updateConversationParticipants({ conversationId: first.id, actorId: creator, addUserIds: [third], removeUserIds: [] });
      const replay = await runtime.store.createConversation(input);
      assert.equal(replay.id, first.id);
      assert.deepEqual(replay.participantIds, [creator, invited, third].sort());

      await runtime.store.deleteConversation({ conversationId: theirs.id, actorId: invited });
    } finally {
      await runtime.cleanup(conversationId, suffix);
    }
  });

  test(`${adapterName}: a participant update returns the same active member ids as every other provider`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const creator = `participants-creator-${suffix}`;
    const invited = `participants-invited-${suffix}`;
    const joined = `participants-joined-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({ actorId: creator, participantIds: [invited] });
      conversationId = conversation.id;
      const result = await runtime.store.updateConversationParticipants({
        conversationId, actorId: creator, addUserIds: [joined], removeUserIds: [invited],
      });
      assert.deepEqual(result, [creator, joined].sort());
      assert.deepEqual((await runtime.store.getConversation({ conversationId, actorId: creator })).participantIds, [creator, joined].sort());
    } finally {
      await runtime.cleanup(conversationId, suffix);
    }
  });

  test(`${adapterName}: expired and superseded outbox leases cannot acknowledge or postpone events`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: `sender-${suffix}`, body: "lease fencing", idempotencyKey: `key-${suffix}`,
      });

      const [first] = await runtime.store.claimOutboxEvents({ limit: 1, leaseSeconds: 60 });
      assert.ok(first);
      await assert.rejects(runtime.store.markOutboxDelivered({ eventId: first.id }), /leaseToken/);
      await assert.rejects(runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: "not-a-uuid" }), /leaseToken/);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: first.id, leaseToken: randomUUID() }), false);
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: randomUUID() }), false);
      await runtime.makeOutboxAvailable(first.id);
      // Expiry alone invalidates the lease, even before another worker claims it.
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: first.lease_token }), false);

      const [second] = await runtime.store.claimOutboxEvents({ limit: 1, leaseSeconds: 60 });
      assert.equal(second.id, first.id);
      assert.equal(second.attempts, 2);
      assert.equal(typeof first.lease_token, "string");
      assert.equal(typeof second.lease_token, "string");
      assert.notEqual(second.lease_token, first.lease_token);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: second.id, leaseToken: second.lease_token }), true);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: second.id, leaseToken: second.lease_token }), false);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: rescheduling releases a lease and a retry gets a new token`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: `sender-${suffix}`, body: "retry fencing", idempotencyKey: `key-${suffix}`,
      });
      const [first] = await runtime.store.claimOutboxEvents({ limit: 1 });
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: first.lease_token, delaySeconds: 60 }), true);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);
      await runtime.makeOutboxAvailable(first.id);
      const [retry] = await runtime.store.claimOutboxEvents({ limit: 1 });
      assert.equal(retry.id, first.id);
      assert.equal(retry.attempts, 2);
      assert.notEqual(retry.lease_token, first.lease_token);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: retry.id, leaseToken: retry.lease_token }), true);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: concurrent workers cannot claim the same active outbox lease`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: `sender-${suffix}`, body: "one lease", idempotencyKey: `key-${suffix}`,
      });
      const claims = await Promise.all([
        runtime.store.claimOutboxEvents({ limit: 1 }),
        runtime.store.claimOutboxEvents({ limit: 1 }),
      ]);
      assert.equal(claims.flat().length, 1);
      const [event] = claims.flat();
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: event.id, leaseToken: event.lease_token }), true);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  for (const outcome of ["success", "failure"]) {
    test(`${adapterName}: a ${outcome} from a stale worker cannot disturb a newer lease`, options, async () => {
      const runtime = await fixture();
      const suffix = randomUUID();
      let conversationId;
      try {
        const conversation = await runtime.store.createConversation({
          actorId: `sender-${suffix}`,
          participantIds: [`recipient-${suffix}`],
        });
        conversationId = conversation.id;
        await runtime.store.persistMessage({
          conversationId, senderId: `sender-${suffix}`, body: "worker lease", idempotencyKey: `key-${suffix}`,
        });
        let newerLease;
        const result = await dispatchOutboxBatch({
          store: runtime.store,
          limit: 1,
          deliver: async (event) => {
            await runtime.makeOutboxAvailable(event.id);
            [newerLease] = await runtime.store.claimOutboxEvents({ limit: 1 });
            if (outcome === "failure") throw new Error("simulated stale delivery failure");
          },
        });
        assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1, deadLettered: 0 });
        assert.ok(newerLease);
        assert.equal(await runtime.outboxAvailableAt(newerLease.id), new Date(newerLease.available_at).toISOString());
        assert.equal(await runtime.store.markOutboxDelivered({ eventId: newerLease.id, leaseToken: newerLease.lease_token }), true);
      } finally {
        await runtime.cleanup(conversationId);
      }
    });
  }

  test(`${adapterName}: a worker does not lease the rest of a batch while delivering one event`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      for (const key of ["first", "second"]) {
        await runtime.store.persistMessage({
          conversationId, senderId: `sender-${suffix}`, body: key, idempotencyKey: `${key}-${suffix}`,
        });
      }
      let otherWorkerEvent;
      const result = await dispatchOutboxBatch({
        store: runtime.store,
        limit: 2,
        deliver: async () => { [otherWorkerEvent] = await runtime.store.claimOutboxEvents({ limit: 1 }); },
      });
      assert.ok(otherWorkerEvent, "the next event should remain available to another worker");
      assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0, deadLettered: 0 });
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: otherWorkerEvent.id, leaseToken: otherWorkerEvent.lease_token }), true);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: a partial inbox delivery retries without losing or duplicating notifications`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const sender = `sender-${suffix}`;
    const firstRecipient = `recipient-a-${suffix}`;
    const secondRecipient = `recipient-z-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: sender, participantIds: [firstRecipient, secondRecipient],
      });
      conversationId = conversation.id;
      const message = await runtime.store.persistMessage({
        conversationId, senderId: sender, body: "offline delivery", idempotencyKey: `key-${suffix}`,
      });
      let firstEvent;
      const firstAttempt = await dispatchOutboxBatch({
        store: runtime.store, limit: 1, retryDelaySeconds: 60,
        deliver: async (event) => {
          firstEvent = event;
          // Simulate an older worker that committed one recipient before it
          // crashed. The new atomic consumer must recover this legacy backlog.
          await runtime.store.createNotification({
            userId: firstRecipient,
            eventKey: event.event_key,
            payload: { type: "message.created", messageId: message.id, conversationId, senderId: sender },
          });
          throw new Error("simulated transient inbox failure");
        },
      });
      assert.deepEqual(firstAttempt, { claimed: 1, delivered: 0, failed: 1, deadLettered: 0 });
      assert.equal((await runtime.store.listNotifications({ actorId: firstRecipient })).length, 1);
      assert.equal((await runtime.store.listNotifications({ actorId: secondRecipient })).length, 0);
      assert.equal((await runtime.store.listNotifications({ actorId: sender })).length, 0);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);

      await runtime.makeOutboxAvailable(firstEvent.id);
      let retryEvent;
      const retry = await dispatchOutboxBatch({
        store: runtime.store, limit: 1,
        deliver: async (event) => {
          retryEvent = event;
          await createMessageNotificationDelivery({ store: runtime.store })(event);
        },
      });
      assert.deepEqual(retry, { claimed: 1, delivered: 1, failed: 0, deadLettered: 0 });
      assert.equal(retryEvent.attempts, 2);
      assert.notEqual(retryEvent.lease_token, firstEvent.lease_token);
      for (const recipient of [firstRecipient, secondRecipient]) {
        const inbox = await runtime.store.listNotifications({ actorId: recipient });
        assert.equal(inbox.length, 1);
        assert.equal(inbox[0].eventKey, `message:${message.id}`);
        assert.equal(inbox[0].payload.messageId, message.id);
        assert.equal(inbox[0].payload.conversationId, conversationId);
        assert.equal(inbox[0].payload.senderId, sender);
      }
      assert.equal((await runtime.store.listNotifications({ actorId: sender })).length, 0);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  /**
   * The inbox cursor is the whole feature, and the two engines disagree about
   * time by default: SQLite stores the millisecond text it was given, PostgreSQL
   * stores `now()`'s microseconds. These assertions are the same on both, and the
   * ones about a shared millisecond are the reason migration 0030 exists.
   */
  test(`${adapterName}: the inbox pages backwards by (createdAt, id) without repeats or gaps`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const reader = `notif-page-reader-${suffix}`;
    const stranger = `notif-page-stranger-${suffix}`;
    // Newest first, oldest last, with three rows inside one millisecond so the id
    // tie-break has something to decide.
    const schedule = [
      "2026-06-01T00:00:00.125Z",
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.121Z",
    ];
    /** The order a cursor walk must produce: newer first, then id descending. */
    const newestFirst = (rows) => [...rows].sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
      return left.id < right.id ? 1 : -1;
    });
    try {
      const mine = [];
      for (const [index, createdAt] of schedule.entries()) {
        const created = await runtime.store.createNotification({
          userId: reader, eventKey: `page-${index}-${suffix}`, payload: { type: "page.test", index },
        });
        await runtime.setNotificationCreatedAt(created.id, createdAt);
        mine.push({ id: created.id, createdAt });
      }
      const theirs = [];
      for (const [index, createdAt] of schedule.slice(0, 2).entries()) {
        const created = await runtime.store.createNotification({
          userId: stranger, eventKey: `page-stranger-${index}-${suffix}`, payload: { type: "page.test" },
        });
        await runtime.setNotificationCreatedAt(created.id, createdAt);
        theirs.push({ id: created.id, createdAt });
      }
      const expected = newestFirst(mine).map((row) => row.id);

      /** Page like a client does: no cursor first, then the last row of each page. */
      const walk = async (pageSize, { onPage } = {}) => {
        const seen = [];
        let last = null;
        let page = 0;
        for (;;) {
          const rows = await runtime.store.listNotifications({
            actorId: reader,
            limit: pageSize,
            ...(last === null ? {} : { cursor: { at: last.createdAt, id: last.id } }),
          });
          if (rows.length === 0) break;
          assert.ok(rows.length <= pageSize, "a page never exceeds its limit");
          for (const row of rows) seen.push(row.id);
          last = rows[rows.length - 1];
          page += 1;
          assert.ok(page < 50, "the walk terminates");
          await onPage?.({ page, last, rows });
        }
        return seen;
      };

      // A three-page walk at a size that does not divide the rows.
      const walked = await walk(2);
      assert.deepEqual(walked, expected, "every notification is read once, in order");
      assert.deepEqual([...walked].sort(), [...expected].sort());
      assert.equal(new Set(walked).size, expected.length, "no notification is repeated");
      assert.ok(!walked.some((id) => theirs.some((row) => row.id === id)), "another account's inbox is invisible");

      // A size of one walks the same order.
      assert.deepEqual(await walk(1), expected);
      // And a page larger than the inbox returns everything, then an empty page.
      const all = await runtime.store.listNotifications({ actorId: reader, limit: 100 });
      assert.deepEqual(all.map((row) => row.id), expected);

      // Marking a notification read changes nothing about the order.
      await runtime.store.markNotificationRead({ notificationId: expected[2], actorId: reader });
      assert.deepEqual(await walk(2), expected, "read state does not move a row");

      // A notification that arrives mid-walk is newer than the cursor, so it must
      // not shift the older pages: no repeats, and nothing old is skipped.
      const seenWithIntruder = await walk(2, {
        onPage: async ({ page }) => {
          if (page !== 1) return;
          const intruder = await runtime.store.createNotification({
            userId: reader, eventKey: `page-intruder-${suffix}`, payload: { type: "page.test", intruder: true },
          });
          await runtime.setNotificationCreatedAt(intruder.id, "2026-06-01T00:00:09.000Z");
        },
      });
      assert.deepEqual(seenWithIntruder, expected, "a newer insert neither repeats nor hides an older row");

      // The stranger's own inbox pages independently.
      const strangerPage = await runtime.store.listNotifications({ actorId: stranger, limit: 1 });
      assert.equal(strangerPage.length, 1);
      assert.equal(strangerPage[0].userId, stranger);
      const strangerRest = await runtime.store.listNotifications({
        actorId: stranger, limit: 10,
        cursor: { at: strangerPage[0].createdAt, id: strangerPage[0].id },
      });
      assert.deepEqual(
        [...strangerPage, ...strangerRest].map((row) => row.id),
        newestFirst(theirs).map((row) => row.id),
      );

      // Limits and cursor shapes are validated, not guessed at.
      await assert.rejects(runtime.store.listNotifications({ actorId: reader, limit: 0 }), TypeError);
      await assert.rejects(runtime.store.listNotifications({ actorId: reader, limit: 101 }), TypeError);
      await assert.rejects(runtime.store.listNotifications({ actorId: reader, cursor: "not-a-cursor" }), TypeError);
      await assert.rejects(runtime.store.listNotifications({ actorId: reader, cursor: { at: "2026-06-01T00:00:00.123Z" } }), TypeError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: a pending message notifies current members even after its sender leaves`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const owner = `owner-${suffix}`;
    const sender = `sender-${suffix}`;
    const remaining = `remaining-${suffix}`;
    const removed = `removed-${suffix}`;
    const joinedLater = `joined-later-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: owner, participantIds: [sender, remaining, removed],
      });
      conversationId = conversation.id;
      const message = await runtime.store.persistMessage({
        conversationId, senderId: sender, body: "pending notification", idempotencyKey: `key-${suffix}`,
      });
      await runtime.store.updateConversationParticipants({
        conversationId, actorId: owner, removeUserIds: [sender, removed], addUserIds: [joinedLater],
      });
      let deliveredEvent;
      const result = await dispatchOutboxBatch({
        store: runtime.store, limit: 1,
        deliver: async (event) => {
          deliveredEvent = event;
          await createMessageNotificationDelivery({ store: runtime.store })(event);
        },
      });
      assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0, deadLettered: 0 });
      // Retrying an already committed delivery must remain safe.
      await createMessageNotificationDelivery({ store: runtime.store })(deliveredEvent);
      for (const user of [owner, remaining, joinedLater]) {
        const inbox = await runtime.store.listNotifications({ actorId: user });
        assert.equal(inbox.length, 1);
        assert.equal(inbox[0].eventKey, `message:${message.id}`);
        assert.equal(inbox[0].payload.senderId, sender);
      }
      assert.equal((await runtime.store.listNotifications({ actorId: sender })).length, 0);
      assert.equal((await runtime.store.listNotifications({ actorId: removed })).length, 0);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: a stale delivery after conversation deletion never creates orphaned inbox rows`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const owner = `delete-owner-${suffix}`;
    const recipient = `delete-recipient-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({ actorId: owner, participantIds: [recipient] });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: owner, body: "delete while in flight", idempotencyKey: `key-${suffix}`,
      });
      const [event] = await runtime.store.claimOutboxEvents({ limit: 1 });
      assert.ok(event);
      assert.equal(await runtime.store.deleteConversation({ conversationId, actorId: owner }), true);
      await createMessageNotificationDelivery({ store: runtime.store })(event);
      assert.equal((await runtime.store.listNotifications({ actorId: recipient })).length, 0);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: event.id, leaseToken: event.lease_token }), false);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: an inbox idempotency conflict rolls back the whole message delivery`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const sender = `rollback-sender-${suffix}`;
    const first = `rollback-a-${suffix}`;
    const conflicted = `rollback-z-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({ actorId: sender, participantIds: [first, conflicted] });
      conversationId = conversation.id;
      const message = await runtime.store.persistMessage({ conversationId, senderId: sender, body: "atomic inbox", idempotencyKey: `key-${suffix}` });
      await runtime.store.createNotification({ userId: conflicted, eventKey: `message:${message.id}`, payload: { type: "different" } });
      const [event] = await runtime.store.claimOutboxEvents({ limit: 1 });
      await assert.rejects(createMessageNotificationDelivery({ store: runtime.store })(event), IdempotencyConflictError);
      assert.equal((await runtime.store.listNotifications({ actorId: first })).length, 0);
      const conflictInbox = await runtime.store.listNotifications({ actorId: conflicted });
      assert.equal(conflictInbox.length, 1);
      assert.deepEqual(conflictInbox[0].payload, { type: "different" });
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: event.id, leaseToken: event.lease_token, delaySeconds: 1 }), true);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: notifications are user-scoped, idempotent, and reject event payload conflicts`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userA = `contract-user-a-${suffix}`;
    const userB = `contract-user-b-${suffix}`;
    try {
      const payload = { type: "contract.notification", nested: { value: 1 } };
      const first = await runtime.store.createNotification({ userId: userA, eventKey: `event-${suffix}`, payload });
      const retry = await runtime.store.createNotification({ userId: userA, eventKey: `event-${suffix}`, payload });
      assert.equal(first.duplicate, false);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.id, first.id);
      await assert.rejects(
        runtime.store.createNotification({
          userId: userA,
          eventKey: `event-${suffix}`,
          payload: { type: "different" },
        }),
        IdempotencyConflictError,
      );
      await runtime.store.createNotification({ userId: userB, eventKey: `other-event-${suffix}`, payload: { type: "private" } });
      assert.equal(await runtime.store.getUnreadNotificationCount({ actorId: userA }), 1);
      assert.equal((await runtime.store.listNotifications({ actorId: userA })).length, 1);
      assert.equal(await runtime.store.markNotificationRead({ notificationId: first.id, actorId: userB }), null);
      const read = await runtime.store.markNotificationRead({ notificationId: first.id, actorId: userA });
      assert.equal(read.id, first.id);
      assert.ok(read.readAt);
      assert.equal((await runtime.store.markNotificationRead({ notificationId: first.id, actorId: userA })).readAt, read.readAt);
      assert.equal(await runtime.store.getUnreadNotificationCount({ actorId: userA }), 0);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  /**
   * The batch inbox write (audit F-23).
   *
   * Deleting a work tells up to 200 commenters. The per-row call is a transaction
   * of its own, so the desk used to hold the SQLite write lock 200 times inside one
   * `DELETE` request. The batch must be *the same work*, not a cheaper variant:
   * same receipts, same duplicate handling, same payload-conflict refusal, and one
   * transaction that either lands whole or not at all.
   */
  test(`${adapterName}: batch inbox writes match the single writes, in order and in one transaction`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const users = [`batch-notify-a-${suffix}`, `batch-notify-b-${suffix}`, `batch-notify-c-${suffix}`];
    try {
      const events = users.map((userId, index) => ({
        userId,
        eventKey: `batch-event-${index}-${suffix}`,
        payload: { type: "contract.batch", index },
      }));

      // The per-row answer, for comparison.
      const singles = [];
      for (const event of events) singles.push(await runtime.store.createNotification(event));

      // A batch of the same events is all duplicates of what already exists, reported
      // in input order and with the ids the first writes produced.
      const duplicates = await runtime.store.createNotifications(events);
      assert.deepEqual(duplicates.map((receipt) => receipt.userId), users);
      assert.deepEqual(duplicates.map((receipt) => receipt.duplicate), [true, true, true]);
      assert.deepEqual(duplicates.map((receipt) => receipt.id), singles.map((receipt) => receipt.id));

      // New keys in one call: one receipt each, none of them a duplicate.
      const fresh = await runtime.store.createNotifications(
        users.map((userId, index) => ({
          userId,
          eventKey: `batch-fresh-${index}-${suffix}`,
          payload: { type: "contract.batch.fresh", index },
        })),
      );
      assert.deepEqual(fresh.map((receipt) => receipt.duplicate), [false, false, false]);
      assert.equal(new Set(fresh.map((receipt) => receipt.id)).size, users.length);
      assert.equal(await runtime.store.getUnreadNotificationCount({ actorId: users[0] }), 2);

      // One conflict inside a batch refuses the whole batch: a caller that asked
      // for three notices is never handed two and no error.
      const before = await runtime.store.getUnreadNotificationCount({ actorId: users[1] });
      await assert.rejects(
        runtime.store.createNotifications([
          { userId: users[1], eventKey: `batch-fresh-1-${suffix}`, payload: { type: "conflict.retry" } },
          { userId: users[1], eventKey: `batch-rollback-${suffix}`, payload: { type: "contract.batch.rollback" } },
        ]),
        IdempotencyConflictError,
      );
      assert.equal(await runtime.store.getUnreadNotificationCount({ actorId: users[1] }), before, "nothing from the failed batch landed");

      // An empty batch is a no-op, not an error.
      assert.deepEqual(await runtime.store.createNotifications([]), []);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: session revocation preserves the furthest expiry and expires on schedule`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const sessionId = `contract-session-${suffix}`;
    try {
      assert.equal(await runtime.store.isSessionRevoked(sessionId), false);
      await runtime.store.revokeSession({ sessionId, expiresAt: "2099-01-01T00:00:00.000Z" });
      assert.equal(await runtime.store.isSessionRevoked(sessionId), true);
      await runtime.store.revokeSession({ sessionId, expiresAt: "2098-01-01T00:00:00.000Z" });
      assert.equal(await runtime.store.isSessionRevoked(sessionId), true);
      const expiredId = `contract-expired-session-${suffix}`;
      await runtime.store.revokeSession({ sessionId: expiredId, expiresAt: "2000-01-01T00:00:00.000Z" });
      assert.equal(await runtime.store.isSessionRevoked(expiredId), false);
      if (runtime.store === postgresStore) {
        await postgresSql.unsafe("DELETE FROM revoked_sessions WHERE session_id = $1", [expiredId]);
      } else {
        // Expired rows are harmless but remove the fixture to keep the test isolated.
        // The SQLite fixture is closed immediately after this test.
      }
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });
  test(`${adapterName}: localized profiles, follow permissions, counts, and notifications stay consistent`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const followerId = `profile-follower-${suffix}`;
    const targetId = `profile-target-${suffix}`;
    const otherId = `profile-other-${suffix}`;
    try {
      const initial = await runtime.store.upsertAuthorProfile({
        userId: targetId, displayName: "Profile Target", bio: "English bio",
        avatarUrl: "/avatars/profile-target.png", websiteUrl: "https://example.com", locale: "en",
      });
      assert.equal(initial.followerCount, 0);
      await runtime.store.upsertAuthorProfile({ userId: targetId, displayName: "目标用户", bio: "中文简介", locale: "zh-CN" });
      const preserved = await runtime.store.upsertAuthorProfile({
        userId: targetId, displayName: "Updated Target", bio: "Updated English bio", locale: "en",
      });
      assert.equal(preserved.avatarUrl, "/avatars/profile-target.png");
      assert.equal(preserved.websiteUrl, "https://example.com/");
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "zh-CN" })).displayName, "目标用户");
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "en" })).displayName, "Updated Target");

      await runtime.store.upsertAuthorProfile({ userId: followerId, displayName: "Follower", locale: "en" });
      await runtime.store.upsertAuthorProfile({ userId: otherId, displayName: "Other Follower", locale: "en" });
      assert.equal(await runtime.store.followUser({ actorId: followerId, targetUserId: targetId }), true);
      assert.equal(await runtime.store.followUser({ actorId: followerId, targetUserId: targetId }), false);
      assert.equal(await runtime.store.followUser({ actorId: otherId, targetUserId: targetId }), true);

      const viewed = await runtime.store.getAuthorProfile({ userId: targetId, locale: "en", viewerId: followerId });
      assert.equal(viewed.followerCount, 2);
      assert.equal(viewed.isFollowing, true);
      assert.deepEqual((await runtime.store.listFollowing({ userId: followerId, locale: "en" })).map((item) => item.userId), [targetId]);
      assert.deepEqual((await runtime.store.listFollowers({ userId: targetId, locale: "en" })).map((item) => item.userId).sort(), [followerId, otherId].sort());
      assert.ok((await runtime.store.searchUsers({ query: targetId, locale: "en" })).some((item) => item.userId === targetId));

      const followNotifications = (await runtime.store.listNotifications({ actorId: targetId, limit: 100 }))
        .filter((item) => item.payload?.type === "user.followed");
      assert.equal(followNotifications.length, 2);
      assert.deepEqual(followNotifications.map((item) => item.payload.followerId).sort(), [followerId, otherId].sort());

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.followUser({ actorId: targetId, targetUserId: targetId })),
        ProfileInputError,
      );
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.followUser({ actorId: followerId, targetUserId: `profile-missing-${suffix}` })),
        ProfileNotFoundError,
      );
      assert.equal(await runtime.store.unfollowUser({ actorId: followerId, targetUserId: targetId }), true);
      assert.equal(await runtime.store.unfollowUser({ actorId: followerId, targetUserId: targetId }), false);
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "en", viewerId: followerId })).followerCount, 1);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });
  test(`${adapterName}: drafts stay private to the published feed and article updates require ownership`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-draft-${suffix}`;
    const richTextBlocks = [{
      id: "p1", type: "paragraph", text: "Shared contract content.",
      inlines: [{ text: "Shared " }, { text: "contract", marks: ["bold"] }, { text: " content.", href: "/articles/contract" }],
    }];
    let articleId;
    try {
      const draft = await runtime.store.createArticle({
        authorId: `author-${suffix}`, slug, title: "Contract draft", summary: "Not public yet",
        locale: "zh-CN", contentBlocks: richTextBlocks, contentBlocksVersion: 1, publish: false,
      });
      articleId = draft.id;
      assert.equal(draft.status, "draft");
      assert.equal(draft.contentBlocksVersion, 1);
      assert.deepEqual(draft.contentBlocks, richTextBlocks);
      assert.equal((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: slug })).length, 0);
      assert.ok((await runtime.store.listMyArticles({ actorId: `author-${suffix}`, locale: "zh-CN" })).some((article) => article.id === articleId));
      await assert.rejects(Promise.resolve().then(() => runtime.store.updateArticle({
        articleId, actorId: `not-author-${suffix}`, slug, title: "Unauthorized update",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      })), ArticleAuthorizationError);
      const published = await runtime.store.updateArticle({
        articleId, actorId: `author-${suffix}`, slug, title: "Now published", summary: "Visible in public feed",
        locale: "zh-CN", contentBlocks: richTextBlocks, contentBlocksVersion: 1, publish: true,
      });
      assert.equal(published.status, "published");
      assert.equal(published.contentBlocksVersion, 1);
      assert.deepEqual(published.contentBlocks, richTextBlocks);
      assert.ok((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Now published" })).some((article) => article.id === articleId));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: only 小说, 诗歌 and 其他文体 can be written, through the contract or below it`, options, async () => {
    // ADR 0054 folded the six finer work types into three and migrated every
    // stored row. The contract refuses the folded values, and so does the
    // database itself (a CHECK on PostgreSQL, triggers on SQLite), so nothing
    // that bypasses the store can bring one back either.
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-work-type-${suffix}`;
    const block = [{ id: "p1", type: "paragraph", text: "Short form." }];
    try {
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticle({
          authorId: `author-${suffix}`, slug, title: "A short story", locale: "zh-CN",
          contentBlocks: block, workType: "short_story",
        })),
        (error) => error instanceof ArticleInputError,
      );
      // Nothing was written, so the address is still free for a supported type.
      const created = await runtime.store.createArticle({
        authorId: `author-${suffix}`, slug, title: "A short story", locale: "zh-CN",
        contentBlocks: block, workType: "novel",
      });
      assert.equal(created.workType, "novel");

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.updateArticle({
          articleId: created.id, actorId: `author-${suffix}`, slug,
          title: "Now an essay", locale: "zh-CN", contentBlocks: block,
          publish: false, workType: "essay",
        })),
        (error) => error instanceof ArticleInputError,
      );
      const retyped = await runtime.store.updateArticle({
        articleId: created.id, actorId: `author-${suffix}`, slug,
        title: "Now a poem", locale: "zh-CN", contentBlocks: block,
        publish: false, workType: "poetry",
      });
      assert.equal(retyped.workType, "poetry");

      for (const folded of ["serial", "essay", "nonfiction"]) {
        await assert.rejects(runtime.setArticleWorkType(created.id, folded), undefined, `the database must refuse ${folded}`);
      }
      assert.equal(await runtime.articleWorkType(created.id), "poetry", "the refused writes changed nothing");
    } finally { await runtime.cleanup(undefined, suffix); }
  });
}

registerForEngines(registerCoreAdapterContracts);
