# ADR 0009: Message notification recipients at delivery time

- Status: Accepted
- Date: 2026-10-28
- Scope: Existing `message.created` outbox events and in-app inbox notifications

## Context

Messages and their outbox intent commit together; an independent worker later creates inbox records. The previous worker selected current members at delivery, required the sender still to be active, and wrote each recipient independently. Removing the sender could indefinitely retry an otherwise valid event, while deletion or membership changes could race with notification inserts.

## Decision

The product owner selected **current active membership at the time of each delivery attempt**, excluding the original sender even when that sender has since left. A later joiner can receive an older pending message notification; a removed participant is not newly selected after removal. This is not a send-time recipient snapshot. Previously committed inbox rows from an earlier partial attempt are retained; existing pending event payloads and event keys remain compatible.

Serialize message membership checks and outbox writes with membership edits and conversation deletion, so a removed sender cannot win a later write and deletion cannot miss a late event. Select recipients and create all missing notifications in one transaction under the same conversation lock. Verify the event refers to a persisted message and original sender. A stale event for a deleted conversation creates no inbox rows. Existing per-recipient event keys preserve at-least-once idempotency, and conflicting payloads fail the whole transaction instead of silently overwriting a row. A retry after a successful delivery but before acknowledgement may observe a newer membership; previously delivered rows are not recalled.

## Consequences and rollout

Delivery remains at least once, with no lease heartbeat or external push guarantee. Stop old workers before rollout because they do not participate in the conversation lock and can recreate the old race; do not mix versions. The API still needs delivery metrics/alerts, Web reconnection tests and any separately approved push/email provider. No production migration or deployment is implied by this decision.
