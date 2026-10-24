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
- [ ] Build authenticated editor and profile-management UI.
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
