# ADR 0019: A device list with no device fingerprints

- Status: Accepted
- Date: 2026-11-01
- Completes: the "list and revoke a specific session" gap recorded in
  [`docs/api/platform-capability-backlog.md`](../../api/platform-capability-backlog.md), which
  [ADR 0018](0018-session-id-on-access-tokens.md) left open when it folded the old
  `revokeIdentitySessions` into the password replacement.

## Context

Every account transition the project owns ends sessions as a side effect: changing the password
ends the others (ADR 0018), logging out ends one credential, recovery ends all of them. None of
them answers the question an owner actually asks — *what is signed in as me, and how do I stop the
one I lost?* — because nothing enumerated sessions. The backlog has carried it as a gap since the
capability audit, with the note that multi-device management and "I lost my phone" both depend on
it.

The obvious shape of that feature is a list of devices: browser, operating system, city, last seen.
Every one of those is a fact about a person that the server would have to start collecting and
keeping. This project stores no user agent, no IP address and no geolocation anywhere else; a
device list would be the first and only reason to hold them, and would stay in the database long
after the reason passed.

## Decision

The account can list its live sessions and end them, and the list is deliberately thin:

- `GET /api/v1/me/sessions` — the live sessions, newest first, bounded at 50, each one
  `{ sessionId, createdAt, lastUsedAt, expiresAt, current }`.
- `DELETE /api/v1/me/sessions/:sessionId` — end one. `404` when the id is not one of this
  account's live sessions.
- `DELETE /api/v1/me/sessions` — end every *other* session; the one that asks is spared.

Three port methods carry it: `listIdentitySessions`, `revokeIdentitySession` (one) and
`revokeIdentitySessions` (all but one). They are separate from the password replacement on purpose
— that one writes a credential and ends sessions in the same transaction, which is a different
guarantee from "end that device now".

Decisions inside that shape:

- **No device metadata.** `lastUsedAt` is the last time the session refreshed, derived from
  `auth_refresh_tokens.used_at` — a column that already exists for rotation. Nothing new is
  collected, so nothing new has to be retained, disclosed or deleted. A list the owner recognises
  from a timestamp is the honest version; a list of browser fingerprints is a surveillance
  artefact wearing a convenience label.
- **Only live sessions are listed.** A revoked or expired session is not a device anybody can be
  asked about, and counting it in "we signed out N devices" would be a lie.
- **A session belonging to another account is `404`, not `403`.** The three ways an id can fail —
  never existed, already ended, belongs to somebody else — answer identically, so the endpoint
  cannot be used to find out which session ids exist.
- **Ending the device you are holding is allowed.** It is what the logout endpoint already does,
  and a visitor who taps "end" on the row marked `current` should not be told no.
- **Ending the others spares the session that asks**, for the same reason a password change does
  (ADR 0018). A token minted before `sid` existed spares nothing: the safe direction, bounded by
  the token's own lifetime.
- **Throttled** at 30 per account and 120 per peer per 15 minutes. Reading your own devices is
  cheap; enumerating somebody else's session ids should not be.

## Consequences

- No schema change and no migration: `used_at` was already there for rotation, and the rest is
  derived.
- The list is only as informative as a timestamp, so a future "this was me on my phone" label
  cannot be added without a decision to start collecting device data — which is a new ADR, not a
  tweak.
- The Web tier reached it in the same migration: `packages/web-http` owns the three handlers
  (the method, the exact-Origin check on the two writes, the session-id shape check after it,
  cookie-attached forwarding), the application contributes two resource routes and three one-line
  bindings, and the shared `AccountPanel` renders the list — newest first, one row per session,
  "this device" marked, end-one and end-the-others buttons. The list is fetched after the account
  resolves, so the server-rendered page shows only the panel's shell: it is the client bundle that
  carries the section, which is why the build's assets are asserted rather than the HTML, and why
  the row-level behaviour needs a browser to be exercised.
