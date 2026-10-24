# Legacy Frontend Audit Findings

- Status: Initial source-level audit; not a full runtime or production audit.
- Source: `hapmoniym/BOTTHIINK-blog-client`, branch `main`.
- Audited from repository files available on 2026-10-22/23.
- No legacy source files were modified by this audit.

## Stack and structure observed

- Next.js 14 Pages Router, React 18 and TypeScript 5.3.
- Existing routes cover public blog list/detail, category/tag browsing, profiles, auth/password reset, dashboard/editing and conversations.
- English and Chinese locale JSON files exist.
- Existing article editor uses React Quill.
- Existing image pipeline includes Cloudinary-related packages and Next image remote patterns.
- A web app manifest exists.
- Tests use Jest and Testing Library, but the inspected root test is a narrow footer-text render assertion; test depth and full test health have not been measured.
- GraphQL code generation is configured against a local backend schema endpoint.
- Both TanStack Query and urql are dependencies. The app-level provider wraps both query state and a custom GraphQL provider; `useUrqlClient` combines Graphcache, auth exchange, SSE, WebSocket and live-query/diff-patch utilities. Some mutations/queries use TanStack Query and generated GraphQL request helpers. This creates overlapping request/cache/subscription mechanisms that should be rationalized rather than copied into the rewrite.
- Zustand is used for client state and persists notification state through localForage.

## Findings and implications

### FE-01 — Multiple data/cache mechanisms

**Evidence:** `package.json`, `src/pages/_app.tsx`, `src/hooks/useUrqlClient.ts`, `src/hooks/mutation/useSendMessageMutation.tsx`, `src/hooks/query/useMessagesQuery.ts`.

**Observation:** TanStack Query and urql/Graphcache coexist; GraphQL operations also use generated request helpers. SSE and WebSocket clients are both configured in the urql hook.

**Risk:** stale or inconsistent cache state, duplicated invalidation/subscription logic, higher migration and test cost.

**Direction:** choose one primary request/cache model for the web client after the framework/API spike. Keep the transport abstraction thin; use a separate SSE client only if required. Do not add a second cache without a documented use case.

### FE-02 — Client sends identity fields for sensitive operations

**Evidence:** `src/hooks/mutation/useSendMessageMutation.tsx` sends `senderId`; `src/hooks/mutation/useMarkConversationAsReadMutation.tsx` sends `userId`.

**Observation:** The client submits identity fields alongside conversation identifiers. The backend must never trust these fields to establish the authenticated actor.

**Risk:** impersonation or unauthorized read-state mutation if the resolver does not independently bind identity to authenticated context.

**Direction:** API derives actor identity from verified auth context; remove unnecessary client identity parameters in the new contract. Add negative authorization tests before implementation.

### FE-03 — Notification history is browser-persisted state

**Evidence:** `src/hooks/store/useNotificationStore.ts`.

**Observation:** Notifications are stored in a persisted Zustand/localForage store with local viewed state. The inspected backend notification subscriptions produce events, not a durable inbox.

**Risk:** state can be lost with browser storage, is not naturally synchronized across devices, and cannot reliably recover notifications for a user who was offline.

**Direction:** server-side persisted notification inbox is the source of truth. Browser storage may cache presentation state only. Define event identity, read state, cursor/pagination, idempotency and offline recovery.

### FE-04 — PWA support is not yet demonstrated end to end

**Evidence:** `public/manifest.json`; root tree inspection did not identify an obvious service-worker implementation.

**Observation:** A manifest and icons exist. The presence of a manifest alone does not prove installability, caching policy, offline page behavior or Web Push support.

**Risk:** confusing installability with offline operation or reliable background notification delivery.

**Direction:** test service-worker registration, update behavior, cache boundaries, offline fallbacks and permission-based push separately. Never cache private API responses indiscriminately.

### FE-05 — Public SEO and content rendering require explicit regression checks

**Evidence:** `src/pages/blogs/[slug].tsx`, `next.config.js`, `src/helpers/generate-sitemap.js`.

**Observation:** The existing article route uses static generation-related types and dynamically loads some reader/discussion components. SEO and rendering behavior is spread across page and app-level metadata.

**Risk:** migration may accidentally remove crawlable article content, locale metadata, canonical URLs, sitemap coverage or correct unpublished-content handling.

**Direction:** define route-level SEO acceptance criteria and test rendered HTML, metadata, not-found behavior, locale routes and cache policy in the framework spike.

### FE-06 — Editor content compatibility is a migration boundary

**Evidence:** `package.json` includes `react-quill`; `src/pages/_app.tsx` imports Quill styles.

**Risk:** replacing the editor can silently corrupt existing stored rich-text content, embeds, images or links.

**Direction:** inspect actual stored body format and representative sanitized fixtures before selecting Lexical, Tiptap or another editor. Define a versioned content schema and a round-trip compatibility test before migration.

### FE-07 — Existing test coverage is not yet characterized

**Evidence:** `package.json` defines Jest and Testing Library; inspected `__tests__/Index.test.tsx` checks a footer string.

**Risk:** broad rewrite may have no regression net for authorization, data persistence, SEO or critical user journeys.

**Direction:** do not infer that no other tests exist from one file. Inventory all tests, run them in a controlled environment if dependencies are available, and map critical behaviors to tests before removing legacy routes.

## Next audit steps

- Inventory all route handlers, pages, components, GraphQL operations and mutations.
- Inspect generated schema/operations and identify the exact editor storage format.
- Inspect auth/session flow and cookie settings end to end.
- Establish which PWA/service-worker capabilities are actually present.
- Map each retained capability to an acceptance scenario and future module.
