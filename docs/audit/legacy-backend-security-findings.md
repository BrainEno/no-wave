# Legacy Backend Security and Reliability Findings

- Status: Initial source-level findings from selected resolver, context, schema and model files.
- Source: `BrainEno/bot-thk-gqlserver`, branch `main`.
- This is not a penetration test. Findings must be confirmed against the complete schema, middleware, deployment configuration and runtime behavior.
- No legacy backend source files were modified.

## Critical / high-priority findings

### BE-01 — Message sender is accepted from client input

**Evidence:** `src/resolvers/MessageResolvers.ts`, `sendMessage` accepts `senderId` and uses it to create `senderId` and `sender`, despite having authenticated `user` in context.

**Impact:** authenticated users may be able to attribute a message to another user if no other layer rejects it.

**Required behavior:** derive sender from `user._id` only. Add a regression test where a request supplies another user's sender ID and verify the persisted sender is the authenticated user or the request is rejected.

### BE-02 — Mark-as-read mutation trusts caller-supplied user ID

**Evidence:** `src/resolvers/ConversationResolvers.ts`, `markConversationAsRead(userId, conversationId)` has no authenticated context parameter and updates participants using the supplied IDs.

**Impact:** a caller may change another participant's read state or probe conversation identifiers.

**Required behavior:** derive the actor from authenticated context, verify membership, and update only that actor's participant record.

### BE-03 — Blog update/delete authorization appears incomplete

**Evidence:** `src/resolvers/BlogResolvers.ts` update/delete paths must be verified in full; the inspected delete path checks that a user exists but then deletes by `blogId` without a visible owner/admin predicate. The inspected update path loads a blog by ID and saves updates; owner/admin enforcement was not visible in the reviewed segment.

**Impact:** potential unauthorized edits/deletion of other users' content.

**Required behavior:** enforce ownership or explicit admin policy in the database mutation path; return consistent authorization errors and test owner, non-owner, admin and anonymous cases.

### BE-04 — Authentication tokens are logged

**Evidence:** `src/resolvers/AuthResolvers.ts` logs access tokens in login and refresh flows.

**Impact:** logs may become credential stores and enable account compromise.

**Required behavior:** remove token logging; redact authorization headers, cookies, passwords, refresh tokens and reset tokens from structured logs. Treat historic logs as potentially sensitive.

### BE-05 — Password hashing uses a fast custom HMAC-SHA1 construction

**Evidence:** `src/entities/user.ts`, `encryptPassword`, `makeSalt`, `authenticate`.

**Impact:** this is not a modern password-storage scheme designed to resist offline guessing; a fast hash is materially weaker than a password-specific KDF.

**Required behavior:** plan a compatibility-aware migration to Argon2id or an appropriately configured bcrypt/scrypt implementation. Do not bulk-reset or re-hash existing credentials without a reviewed migration and rollback plan. Consider rehash-on-success for legacy accounts.

### BE-06 — Public user queries select email

**Evidence:** `src/resolvers/UserResolvers.ts`, `getUserInfo`, `searchUsers`, `getFollowInfo` include email in returned values or selected fields.

**Impact:** email addresses may be exposed to unauthenticated callers or through public profile/follow listings.

**Required behavior:** define public profile fields separately from private account fields. Email should be returned only to the account owner or a specifically authorized use case.

## High-priority reliability findings

### BE-07 — Conversation membership and participant validation need strengthening

**Evidence:** `src/resolvers/MessageResolvers.ts` checks participant access for the messages query, but `sendMessage` visibly loads a conversation by ID before creating a message and only later looks up the authenticated sender participant. `src/resolvers/ConversationResolvers.ts` creates participant records from client-supplied IDs.

**Impact:** authorization checks are inconsistent and writes may partially persist before validation fails.

**Required behavior:** validate actor membership and all participant IDs before writes. Do not create a message or side effects until authorization and preconditions pass.

### BE-08 — Unawaited participant updates

**Evidence:** `MessageResolvers.sendMessage` uses `notMeParticipants.forEach(async ...)` to save read-state changes without awaiting completion.

**Impact:** resolver may publish updates or return before participant writes finish; failures may be lost.

**Required behavior:** await all required writes; test partial failures and concurrent sends.

### BE-09 — Multi-document message mutation lacks an evident atomic boundary

**Evidence:** `sendMessage` creates a message, updates participant documents, then updates the conversation and publishes events as separate operations. No transaction/outbox is visible in this path.

**Impact:** partial failures can leave inconsistent message, conversation, unread state and event delivery.

**Required behavior:** define the consistency model; use supported transactions where available and/or an idempotent durable event/outbox pattern. Confirm MongoDB deployment supports transactions before relying on them.

### BE-10 — Real-time PubSub is in-process by default

**Evidence:** `src/utils/createSchema.ts` has RedisPubSub setup commented out; the schema uses default TypeGraphQL PubSub behavior. `src/server.ts` exposes GraphQL SSE at `/graphql/stream`.

**Impact:** process-local events do not reliably fan out across multiple API instances or survive restarts.

**Required behavior:** durable message/notification records are the source of truth. Select a cross-instance delivery adapter only after deployment targets are known; reconnect must refresh persisted state.

### BE-11 — Notifications are events rather than a durable inbox

**Evidence:** inspected follow and blog publishing subscription resolvers return notification payloads; no persisted recipient-scoped notification model/inbox was evident in the inspected files.

**Impact:** offline recipients may miss live-only events; notification read state is client-specific.

**Required behavior:** persist notifications and stable event identity, implement pagination/read state/idempotency, and treat SSE/Web Push as delivery hints.

### BE-12 — Reset-password behavior reveals tokens in fallback responses

**Evidence:** `src/resolvers/AuthResolvers.ts`, `forgotPassword` returns a reset URL containing the token when email sending fails.

**Impact:** reset credentials may be disclosed through API responses and client logs; user enumeration behavior also needs review.

**Required behavior:** use a consistent response that does not reveal whether an account exists or expose reset tokens. Log delivery failures safely and provide a secure recovery channel.

## Lifecycle and compatibility findings

### BE-13 — Backend stack is old and requires a deliberate compatibility upgrade

**Evidence:** `package.json` uses Apollo Server 3, GraphQL 15, TypeGraphQL 1.1, TypeScript 4.8, Express 4, and Node engine `>=16 <22`; MongoDB access uses Mongoose 8.

**Impact:** framework, GraphQL and TypeScript upgrades are not independent version bumps; decorator metadata, resolver signatures, subscription transport, middleware and schema generation may change.

**Required behavior:** create a compatibility matrix and test migration spikes. Choose currently supported versions at implementation time, pin them, and avoid upgrading the whole stack blindly in one change.

### BE-14 — Context has inconsistent authorization-header handling and silent verification failures

**Evidence:** `src/context/typeGraphQLContext.ts` checks misspelled `authrization` before `authorization`; SSE and normal GraphQL contexts have separate token extraction paths, and token verification errors are swallowed or logged differently.

**Impact:** auth behavior may differ by transport and malformed tokens may be hard to diagnose.

**Required behavior:** centralize bearer parsing and token verification, fail closed, return consistent unauthenticated context, and test HTTP and SSE paths equivalently.

## Migration guardrails

- Do not copy insecure resolver behavior into the new API.
- Do not perform credential migrations without test fixtures, compatibility design, backup/restore validation and a reviewed rollout.
- Do not expose secrets, token values or sensitive user records in audit reports.
- Add high-risk authorization tests before implementing corresponding new mutations.
- Re-check every finding against the full codebase before declaring it fixed.
