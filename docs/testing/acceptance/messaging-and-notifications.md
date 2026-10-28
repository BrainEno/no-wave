# Acceptance Scenarios: Messaging and Notifications

## MSG-01 — Message is persisted before delivery is attempted

**Risk:** Critical

Given Alice and Bob are participants in a conversation  
When Alice sends a valid message  
Then the API persists the message and updates the conversation's latest-message state  
And only then schedules or publishes best-effort delivery updates.

If delivery fails after persistence, the message remains retrievable.

## MSG-02 — Offline recipient can recover messages

**Risk:** Critical

Given Bob is offline when Alice sends a message  
When Bob later reconnects and opens the conversation  
Then the API returns the persisted message from history  
And unread state is derived from persisted server state rather than a missed live event.

## MSG-03 — Conversation writes are awaited and consistent

**Risk:** Critical

Given a message send requires updating the message, conversation and participant state  
When one required write fails  
Then the API does not report success  
And the consistency/recovery strategy leaves no silently acknowledged partial operation.

## MSG-04 — Duplicate requests do not duplicate logical effects

**Risk:** High

Given a client retries a send or an event is delivered more than once  
When the same idempotency key/event identity is processed again  
Then the system does not create duplicate logical messages or notifications  
And retry behavior is deterministic and documented.

## MSG-05 — Only conversation participants can send messages

**Risk:** Critical

Given Carol is not a participant in Alice and Bob's conversation  
When Carol tries to send a message to its conversation ID  
Then the API rejects the request before creating a message or changing any participant state.

## NOTIF-01 — Notification inbox is server-persisted

**Risk:** Critical

Given Alice follows Bob and Bob publishes an article under the defined notification policy  
When the notification is created  
Then a recipient-scoped notification record is persisted with a stable ID, creation time and read state  
And Alice can retrieve it from a different device or browser.

## NOTIF-02 — Live delivery is not the source of truth

**Risk:** Critical

Given a notification is persisted while Alice is offline  
When Alice later signs in  
Then the inbox API returns the notification even though no live subscription event was received.

## NOTIF-03 — Duplicate event does not duplicate notification

**Risk:** High

Given the same domain event is processed more than once  
When notification creation is retried  
Then a uniqueness/idempotency rule prevents duplicate logical notifications.

## NOTIF-04 — Push failure does not erase notification

**Risk:** High

Given a notification is persisted and a Web Push delivery attempt fails  
When the delivery failure is recorded  
Then the notification remains available in the inbox  
And retry state is separate from read state.

## NOTIF-05 — User can mark notifications read

**Risk:** Medium

Given Alice owns a notification  
When Alice marks it read  
Then the server persists the read state  
And a later request from another device observes the same state.

## Transport recovery

SSE reconnect is not equivalent to replay or durable delivery. After reconnect, the client should refresh inbox/conversation state from the API or resume from a supported cursor. Web Push requires explicit permission and a persisted subscription lifecycle; browser PWA installation alone does not guarantee push.

## NOTIF-06 — Pending messages use delivery-time membership safely

**Risk:** High

Given a persisted message event is pending and the original sender has since been removed<br>
When the worker delivers the event<br>
Then it notifies the other current active members, including a member added after the send, without retrying merely because the sender left<br>
And recipients removed before delivery are not newly selected.

Given delivery races with a membership edit or conversation deletion<br>
Then recipient selection and all inbox inserts serialize with that change<br>
And a stale event for a deleted conversation creates no orphan inbox rows.<br>
Retries retain and deduplicate inbox rows committed by older partial deliveries.


## NOTIF-07 — Worker failures are observable without leaking payloads

**Risk:** High

Given an outbox event fails delivery or loses its lease
When the worker schedules recovery
Then it emits a structured JSON failure record with event ID/type, attempt count, error class and retry-scheduling outcome
And logs do not include event payloads, raw exception messages, access tokens, refresh tokens or lease tokens
And a failure in the logging callback does not interrupt durable retry handling.

If retry scheduling itself fails, the worker records a sanitized batch-level error and continues polling after the configured delay.
