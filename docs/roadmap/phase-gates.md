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
- [x] Select Next.js App Router for Web and a standalone GraphQL API.
- [x] Select PostgreSQL for the new application's persistence.
- [ ] Complete the feature-by-feature traceability inventory and record unresolved product behavior.
- [ ] Agree on visual direction from the forthcoming design brief/design artifacts.
- [ ] Define the new account/identity issuer integration and local development setup.

## Approved architecture change — REST-only API

On 2026-10-27, the product owner approved replacing GraphQL as the sole business HTTP API with versioned REST endpoints. This is a staged migration: do not remove GraphQL until all current operations have REST equivalents and authorization, persistence, retry, and failure behavior are covered by regression tests.

- [x] Record the REST-only decision and require stable `userId` for author identity.
- [x] Constrain the versioned REST public-content contract to `zh-CN`.
- [x] Add public author-profile and author-article REST endpoints; filter author articles in persistence before pagination.
- [x] Add authenticated REST endpoints for listing the current user's articles, creating articles and owner-checked updates; derive actor identity from a verified, non-revoked JWT.
- [ ] Migrate the Web public-content client and sitemap from GraphQL/fixtures to REST.
- [x] Add authenticated REST article create/update/list, profile update, follow/unfollow, explicit article-like state, comment list/create/delete, current-user identity/profile, user search and follower/following list, liked-article/related-article/like-info reads, and current-session revocation routes.
- [x] Harden JWT verification with a pinned access-token type, required issuance/expiry claims, a bounded maximum TTL and fail-closed session-revocation checks.
- [x] Add field-level Article/AuthorProfile/ArticleComment enrichment to REST responses so the route layer does not silently omit GraphQL-resolved fields.
- [x] Record the operation-by-operation field and resolver parity inventory in [REST–GraphQL parity audit](../audit/rest-graphql-parity.md).
- [x] Add REST taxonomy mutations, conversation lifecycle/message read-send, and notification inbox/read-state operations with equivalent authorization, payload fields and regression tests.
- [ ] Add a machine-enforced GraphQL schema-to-REST route contract check and complete Web caller migration before removing the transitional GraphQL runtime.
- [ ] Select and validate SSE/WebSocket only for concrete real-time needs; keep database/outbox state authoritative.
- [ ] Remove GraphQL schema, Yoga runtime, dependencies, environment variables and obsolete tests after REST parity is verified.

The decision is documented in [ADR 0006](decisions/0006-rest-only-business-api.md).

## Approved editor technology — Lexical

On 2026-10-27, the product owner selected Lexical for both the article editor and comment editor. It is a technology decision only; it does not mean that the editor or upload workflow has been implemented.

- [x] Record Lexical as the shared editing engine and define separate article/comment capability profiles.
- [ ] Define/version the application-owned rich-text document contract, including inline marks and links missing from the current article-block contract.
- [ ] Add tested, lossless adapters between Lexical state and the application document schema; validate node types, URLs, nesting and payload limits on the server.
- [ ] Implement the article editor, draft recovery and approved image-upload integration.
- [ ] Implement the comment editor with a smaller supported-node set and explicit comment payload/storage contract.
- [ ] Add round-trip, malformed-payload, security, Chinese IME, accessibility, keyboard and mobile tests.

See [ADR 0007](decisions/0007-lexical-rich-text-editors.md) for the decision and boundaries.

## Phase 1 — Workspace, CI and API foundation

- [x] Create pnpm workspace and repeatable CI.
- [x] Add GraphQL API, input validation, server-derived identity and database-aware readiness.
- [x] Introduce application service composition and domain-grouped persistence ports.
- [x] Add disposable PostgreSQL integration tests and versioned migrations.
- [ ] Add MongoDB and SQLite adapters against the shared port contract, with transaction and capability differences explicit.
- [ ] Add provider contract tests so each adapter demonstrates equivalent business behavior.
- [ ] Eliminate remaining config/runtime gaps and add API/Web contract checks.
- [ ] Finish API/Web contract verification and remove fixture fallback from environments that are configured for API-backed content. Public article listing, article detail, and author routes now support `API_GRAPHQL_URL`; fixture content remains for isolated builds and local design work.

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
- [x] Add explicit literary work-type metadata to article records and the public GraphQL/Web contract.
- [x] Make Simplified Chinese (zh-CN) the default Web/API locale while retaining Traditional Chinese compatibility.

Exit gate: public content exposes published data only; mutations are authorized; tags can be created/reused and attached through the API with integration coverage.

## Phase 3 — Messaging, notifications and real-time behavior

- [x] Persist conversations, membership, messages, unread/read state and notification inbox.
- [x] Add cursor pagination, session revocation and transactional outbox dispatch/retry primitives.
- [ ] Verify Web/API end-to-end behavior with real authentication, including reconnect/offline recovery.
- [ ] Choose and configure any external Web Push/email provider only after requirements and credentials are approved.
- [ ] Design cross-engine change capture/checkpoints and recovery after the write-authority and RPO/RTO decisions are approved.
- [ ] Complete delivery observability and failure-recovery acceptance.

Exit gate: persisted state is the source of truth, access denial is tested, and retries/reconnect do not lose or duplicate logical messages/notifications.

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
