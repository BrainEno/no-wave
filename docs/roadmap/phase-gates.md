# New Product Roadmap and Phase Gates

The goal is functional coverage of the previous product through a new implementation, not source-code compatibility. Every phase should preserve verified product capabilities while leaving legacy implementation choices behind.

## Product-decision gate

Before a change that would alter user-visible behavior, permission boundaries, destructive lifecycle rules, import/compatibility guarantees, or domain semantics:
1. Summarize the existing/expected behavior and uncertainty.
2. Offer viable options and risks.
3. Recommend one option and wait for approval before implementing the product decision.

Security fixes and implementation details that fulfill already-approved behavior can proceed without waiting.

## Phase 0 — Product behavior and architecture baseline

- [x] Establish agentic coding and behavior-first, risk-based testing rules.
- [x] Review representative legacy source and record an initial capability/security inventory.
- [x] Decide that this repository is an independent implementation; legacy source is a product reference rather than a technical constraint.
- [x] Record Next.js App Router as the initial Web framework decision ([ADR 0002](../architecture/decisions/0002-web-framework-evaluation.md)); the current framework target is superseded by [ADR 0012](../architecture/decisions/0012-portable-web-framework-migration.md), which selects React Router 7 Framework Mode.
- [x] Select SQLite as the default provider for new/local installs, retain PostgreSQL as a supported adapter, and record MongoDB as a future adapter with online change-capture/cutover requirements (ADR 0010).
- [ ] Complete the feature-by-feature traceability inventory and record unresolved product behavior.
- [ ] Agree on visual direction from the forthcoming design brief/design artifacts.
- [x] Select self-hosted API identity and document the initial local issuer contract ([ADR 0008](../architecture/decisions/0008-self-hosted-api-identity.md)).
- [ ] Complete email verification, recovery, browser storage, operational hardening and Web authentication before production use.

## Approved architecture change — REST-only API

The product owner has confirmed that GraphQL must be completely removed and REST is the sole business HTTP API. Do not add GraphQL operations. Complete the remaining Web caller migration in a separate Web-focused change, then remove the transitional GraphQL/Yoga runtime and packages. This backend-only provider change does not edit `apps/web/` to avoid conflict with the active UI work.

- [x] Record the REST-only decision and require stable `userId` for author identity.
- [x] Constrain the versioned REST public-content contract to `zh-CN`.
- [x] Add public author-profile and author-article REST endpoints; filter author articles in persistence before pagination.
- [x] Add authenticated REST endpoints for listing the current user's articles, creating articles and owner-checked updates; derive actor identity from a verified, non-revoked JWT.
- [ ] Migrate the Web public-content client and sitemap from GraphQL/fixtures to REST.
- [x] Add authenticated REST article create/update/list, profile update, follow/unfollow, explicit article-like state, comment list/create/delete, current-user identity/profile, user search and follower/following list, liked-article/related-article/like-info reads, and current-session revocation routes.
- [x] Harden JWT verification with a pinned access-token type, required issuance/expiry claims, a bounded maximum TTL and fail-closed session-revocation checks.
- [x] Add initial self-hosted registration/login, refresh rotation/reuse detection, per-session logout and durable throttling; retain the existing verifier. Production identity gates remain open.
- [x] Add field-level Article/AuthorProfile/ArticleComment enrichment to REST responses so the route layer does not silently omit GraphQL-resolved fields.
- [x] Record the operation-by-operation field and resolver parity inventory in [REST–GraphQL parity audit](../audit/rest-graphql-parity.md).
- [x] Add REST taxonomy mutations, conversation lifecycle/message read-send, and notification inbox/read-state operations with equivalent authorization, payload fields and regression tests.
- [x] Add a CI-enforced GraphQL schema-to-REST operation/route inventory and shared-object field contract test.
- [ ] Complete Web caller migration and end-to-end verification before removing the transitional GraphQL runtime.
- [ ] Select and validate SSE/WebSocket only for concrete real-time needs; keep database/outbox state authoritative.
- [ ] Remove GraphQL schema, Yoga runtime, dependencies, endpoint/configuration and obsolete tests after the remaining Web caller migrates to REST; no new GraphQL code is permitted.

The decision is documented in [ADR 0006](../architecture/decisions/0006-rest-only-business-api.md).

## Approved editor technology — Lexical

On 2026-10-27, the product owner selected Lexical for both the article editor and comment editor. It is a technology decision only; it does not mean that the editor or upload workflow has been implemented.

- [x] Record Lexical as the shared editing engine and define separate article/comment capability profiles.
- [x] Define and persist the application-owned article rich-text contract version 1, adding inline marks and safe links while retaining version-0 compatibility.
- [x] Add tested JSON adapters between Lexical EditorState and article content v1 for standard paragraph, heading, quote, list, link/mark and code nodes; unsupported/custom nodes fail closed and both directions have round-trip tests.
- [x] Wire the strict adapter into authenticated REST article create/update as a write-only ingress while retaining application-owned content blocks for persistence and read responses; verify accepted rich text and fail-closed cases at the HTTP boundary.
- [ ] Add registered custom-image node/upload support and preserve additional Lexical metadata only after its application document contract is approved.
- [x] Validate versioned article node types, safe URLs, inline marks, plain-text fallbacks and serialized payload limits on the server.
- [ ] Implement the article editor, draft recovery and approved image-upload integration.
- [x] Define and persist the smaller paragraph-only comment rich-text v1 contract with legacy plain-text fallback, safe inline marks/links, REST Lexical ingress, PostgreSQL/SQLite migrations and persistence/security tests.
- [ ] Implement the comment editor with the approved smaller supported-node set.
- [ ] Add round-trip, malformed-payload, security, Chinese IME, accessibility, keyboard and mobile tests.

See [ADR 0007](../architecture/decisions/0007-lexical-rich-text-editors.md) for the decision and boundaries.

## Phase 1 — Workspace, CI and API foundation

- [x] Create pnpm workspace and repeatable CI.
- [x] Build the API core, application services and domain-grouped persistence ports; REST is the target business transport.
- [x] Keep PostgreSQL as a supported adapter with versioned migrations.
- [x] Register SQLite as the default runtime provider, run provider-matched migrations explicitly, and fail closed if its schema is missing or stale.
- [ ] Implement the MongoDB adapter against the shared port contract, including transaction/outbox semantics.
- [ ] Complete cross-provider contract parity for all domain operations and provider-specific failure behavior.
- [ ] Implement online change capture, target replay/checkpoints, reconciliation and fenced provider cutover; a configuration-only switch is not a live migration.
- [ ] Eliminate remaining config/runtime gaps and add API/Web contract checks.
- [ ] Migrate remaining Web API callers from GraphQL/fixtures to versioned REST, then remove the transitional GraphQL runtime. Do not change `apps/web/` as part of backend-only provider work.

Exit gate: clean install, typecheck, tests, production build and container smoke are green; Web/API contracts are explicit.

## Phase 2 — Core content and community domain

- [x] Persist articles, localized content blocks, drafts/publication state and owner-checked updates.
- [x] Persist localized author profiles and follows.
- [x] Persist article likes/comments, with ownership and notification tests.
- [x] Add dynamic user-created Unicode hashtags; allow users to reuse existing tags and attach them to articles.
- [ ] Complete public content search and pagination against the API.
- [x] Add API-backed localized category index and category detail routes for public literary discovery.
- [ ] Confirm product rules for tag deletion/moderation and category creation/ownership before expanding those behaviors.
- [ ] Build the Lexical article editor and comment editor, plus profile-management UI.
- [x] Add explicit literary work-type metadata to article records and the public REST/Web contract.
- [x] Make Simplified Chinese (zh-CN) the default Web/API locale while retaining Traditional Chinese compatibility.

Exit gate: public content exposes published data only; mutations are authorized; tags can be created/reused and attached through the API with integration coverage.

## Phase 3 — Messaging, notifications and real-time behavior

- [x] Persist conversations, membership, messages, unread/read state and notification inbox.
- [x] Add cursor pagination, session revocation and transactional outbox dispatch/retry primitives.
- [x] Fence outbox acknowledgements and retries with per-claim tokens; exercise expired/superseded leases, partial inbox retries and a PostgreSQL REST-to-inbox recovery journey.
- [x] Apply the approved delivery-time recipient policy, recover when the sender has left, preserve legacy partial inbox rows, and serialize delivery with membership changes/deletion ([ADR 0009](../architecture/decisions/0009-message-notification-recipient-timing.md)).
- [ ] Verify Web/API end-to-end behavior with real authentication, including reconnect/offline recovery.
- [ ] Choose and configure any external Web Push/email provider only after requirements and credentials are approved.
- [ ] Design cross-engine change capture/checkpoints and recovery after the write-authority and RPO/RTO decisions are approved.
- [x] Emit structured outbox worker failure logs with sanitized error classes, attempt counts and explicit retry-scheduling outcome; keep logging failures isolated from retry handling.
- [ ] Complete delivery observability and failure-recovery acceptance, including queue-depth metrics, alert thresholds and operational recovery drills.

Exit gate: persisted state is the source of truth, access denial is tested, and retries/reconnect do not lose or duplicate logical messages/notifications.

## Approved architecture change — Portable Web framework migration

On 2026-10-29, the owner approved public-page SSR, a client-interactive writing desk, portability-first hosting, and a hard zero-fee/no-credit-card requirement (instance sleep is acceptable). The target is React Router 7 Framework Mode; see [ADR 0012](../architecture/decisions/0012-portable-web-framework-migration.md) and the executable [migration roadmap](frontend-portability-migration.md).

- [x] Record the React Router 7 target and the staged migration decision.
- [x] Audit the current Next.js/Vercel coupling against main commit `d9515c6d66881a7599d35581f38640b0ebb74a78`.
- [ ] Qualify at least one actual hosting candidate for zero cost, no credit card, public access, supported Node SSR and persistent-data/worker requirements before selecting a final host.
- [ ] Build and test an isolated React Router 7 Framework Mode portability proof of concept without replacing the live Next.js app.
- [ ] Prove public SSR, route metadata, hard 404 behavior, private-response cache isolation and standard Node/Docker startup.
- [ ] Move public read-only routes first, preserving URLs, locale behavior, metadata, sitemap and robots output.
- [ ] Migrate auth, writing, comment and media route handlers while preserving the existing HttpOnly cookie, CSRF/origin, token refresh and authorization contracts.
- [ ] Make the notification worker independently runnable with durable processing; do not require a Vercel Daemon as the target design.
- [ ] Validate the selected host's actual signup/payment conditions, sleep/recovery behavior, database durability, object storage and worker execution before deployment.
- [ ] Complete route/E2E/build/typecheck/PostgreSQL integration regression and rehearse rollback before any traffic cutover.
- [ ] Remove Next.js/Vercel-only dependencies only after the replacement is verified and the cutover has explicit approval.

**Scope guard:** the existing API contract, product behavior, database migration protocol and media storage security remain unchanged during the Web framework migration. The existing Neon wiring is not proof that a live account, free/no-card eligibility or a production deployment has been validated. No production deployment, DNS change, paid provisioning, database migration or traffic cutover is implied by this roadmap.

## Phase 4 — Web product and design system

- [x] Establish a localized, crawlable framework spike for home, article archive/detail and author pages.
- [ ] Replace fixture content with API-backed pages.
- [ ] Implement hashtag listing/search/detail routes and article tag rendering.
- [ ] Implement account/authentication and complete the core feature parity journey.
- [ ] Apply the approved Cloud design artifacts to layouts, tokens, components and responsive behavior.
- [ ] Complete SEO, sitemap, accessibility and PWA behavior after data/persistence contracts stabilize.

Exit gate: feature traceability and critical E2E journeys pass; both Traditional Chinese and English layouts are verified.

## Phase 5 — Operations and future clients

- [ ] Verify independent Web/API deployment with Node/Docker.
- [ ] Verify migrations, backup/restore, health/readiness, graceful shutdown, logs and monitoring.
- [ ] Decide whether any historical data import is desired and approve a separate runbook before execution.
- [ ] Design HA inside the chosen primary engine first; add cross-engine warm standby only after consistency/fencing rules are approved.
- [ ] Add React Native/Tauri clients only after API/auth contracts stabilize.

Exit gate: a reviewed deployment/import runbook works outside a single vendor's managed environment. No production deployment or import occurs by implication.
