# Conversation read order and upgrade boundary

## Behavior

A conversation has a monotonically increasing, private message sequence. Each
active member has their own read watermark. An unread message has a sequence
above that member's watermark and a different sender. The sequence is a storage
ordering, not a new client-visible cursor.

A send creates its sequence, message, conversation counter and outbox intent in
one transaction; a duplicate idempotency-key replay creates none of them again.
Mark-all moves only the requesting active member's watermark to the conversation
counter. An added or rejoined member starts at the current counter; re-adding an
already active member does not change their watermark. SQLite's `BEGIN IMMEDIATE`
and PostgreSQL's per-conversation row lock serialize sends, mark-all, membership
changes and deletion. A mark that acquires the lock after a send includes it; a
send that acquires it after the mark stays unread, regardless of either
transaction's wall-clock timestamp. PostgreSQL checks membership before waiting
on the lock and rechecks it after acquiring the lock.

The existing `PUT /conversations/:id/read` request and response are unchanged. It
still marks **all messages persisted before its serialization point**, including
messages not loaded in the browser and messages arriving during the request. It
has no last-seen cursor. A retry after a lost response is a new mark-all and may
cover more messages; the browser does not retry ambiguous outcomes silently.

`GET /conversations/:id/messages?before=<message-id>` keeps the same cursor
shape and returns the newest window oldest-first, now in persistence order.
`lastMessage` uses that order too. Backfill sorts old messages by `(created_at,
id)`, so the old order and existing message-id cursors remain meaningful. New
messages may have non-monotonic `createdAt` values if clocks move or a PostgreSQL
transaction starts early; timestamps remain display data, not the ordering
watermark. No sequence is exposed to clients.

## Upgrade and rollback

The PostgreSQL `0026_conversation_read_order` and SQLite
`0017_conversation_read_order` migrations add and backfill the sequence fields.
They retain each participant's previous unread count under the old predicate
`created_at > last_read_at`. Existing records whose timestamps equal a prior
mark are fundamentally ambiguous: the old schema did not record whether the
message arrived just before or just after it. They remain in their old read
state; this upgrade cannot reconstruct already-missed unread messages.

This is **not a rolling/mixed-version migration**:

1. Rehearse on an isolated copy and take a verified backup. Fence and stop all
   old API writers and notification workers before migrating, and keep them
   stopped until every serving instance uses the new schema and code. Old
   writers do not update sequence watermarks; unsequenced message inserts are
   rejected, but old read-mark operations cannot safely coexist with new ones.
2. Finish or abort all `prepared`, `recording`, `backfilling`, and `catching_up`
   provider-migration sessions. The database migrations refuse to run while such
   a session exists. Backfill is not emitted as a sequence of journal changes.
3. Run the provider's normal explicit migration command during the maintenance
   window, then start the new API/workers together. PostgreSQL locks the relevant
   tables; SQLite holds its write lock. Size the window for the full message and
   membership backfill and index creation, and monitor disk space and backups.
4. Do not resume an old provider snapshot or pre-upgrade journal tail. The
   replayers reject old conversation/message snapshots that lack the sequence
   fields rather than silently dropping unread state. A fresh, coordinated and
   version-matched snapshot/session is required, but the current replayers only
   accept an [empty media baseline](provider-migration-media-references.md); a
   general snapshot importer and watermark protocol are not implemented.
   Conversation counter, message, outbox and member-watermark changes are captured
   transactionally for new sessions; cross-provider hot cutover remains unimplemented. The journal
   contains private message bodies and their user-supplied idempotency keys (now
   included in PostgreSQL capture too), as well as credential-sensitive identity
   snapshots. Restrict access and retention accordingly; never log these rows.
5. Do not roll back by starting the old binary against the upgraded database:
   its timestamp-based semantics cannot interpret the new watermark and it
   cannot insert sequenced messages. Restore the verified pre-upgrade database
   only under an approved recovery plan that accounts for any writes since the
   backup, or use a separately designed and rehearsed reverse migration.

These requirements do not authorize a deployment or a production data change.
