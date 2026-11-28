# Feature Traceability — New Implementation

Status: active

This is the capability map for the new no-wave implementation. Each row names the
modules that own a behaviour, the tests that prove it, and whether the behaviour is
complete. Rows that are not complete point at a numbered entry in
[Unresolved product behaviour](unresolved-product-behavior.md), where the exact
question that has to be answered is written down.

The previous version of this file was a list of claims. Several of them had gone
stale — the tag row still said the Web UI was pending while
`packages/web-ui/src/components/public/tag-view.tsx` and `e2e/tags.spec.ts` were
already in the repository. A stale capability map is worse than none: an agent that
trusts it will rebuild what exists or skip what does not.

## How to read a row

| Column | Meaning |
| --- | --- |
| Capability | The product behaviour, named the way the product names it. |
| Acceptance requirement | What has to be true for a reader or an author. Not a description of the code. |
| Implementation | The modules that own the behaviour. Paths are repository-relative. |
| Verification | The tests that prove the requirement. Every path is a real test file with real cases in it. |
| State | `verified`, `partial` or `open`. |

**State vocabulary**

- `verified` — implemented, and the cited tests cover the requirement.
- `partial` — implemented, with a named remainder. The row cites a `U-xx` id.
- `open` — not implemented. The row cites a `U-xx` id.

A row may only be `partial` or `open` when it cites an id from
[Unresolved product behavior](unresolved-product-behavior.md). A behaviour that is
merely "not finished" is not the same as a behaviour nobody has decided yet, and the
table distinguishes them.

## Capability map

### Public reading surface

| Capability | Acceptance requirement | Implementation | Verification | State |
| --- | --- | --- | --- | --- |
| Public home and article listing | Published content is crawlable; search, filter and pagination are explicit; drafts never leak into a public list. | `packages/web-ui/src/lib/public-pages.ts`, `packages/web-ui/src/components/public/home-view.tsx`, `packages/web-ui/src/components/public/archive-view.tsx`, `apps/web-rr/app/routes/home.tsx`, `apps/web-rr/app/routes/archive.tsx` | `packages/web-ui/src/lib/public-pages.test.ts`, `apps/web-rr/test/web-public-pages.test.ts`, `e2e/home-intro.spec.ts` | verified |
| Article detail, related works and view count | The reading page renders localized content, answers a hard 404 for an unpublished work, links related works, and counts a view once per reader. | `apps/web-rr/app/routes/article.tsx`, `packages/web-ui/src/components/public/article-view.tsx`, `packages/web-ui/src/components/public/article-view-beacon.tsx`, `apps/api/src/application/article-reading.ts`, `apps/api/src/application/article-views.ts` | `e2e/reading-writing-polish.spec.ts`, `e2e/article-views.spec.ts`, `apps/api/src/application/article-views.test.ts` | verified |
| Search | A search term reaches the API, never the browser, and untrusted text stays inert through SSR and hydration. | `packages/web-ui/src/components/public/search-view.tsx`, `apps/web-rr/app/routes/search.tsx`, `packages/web-ui/src/lib/api-content.ts` | `e2e/browser-security.spec.ts`, `apps/web-rr/test/web-public-pages.test.ts` | verified |
| Categories | The category index and detail pages list published works only. | `apps/web-rr/app/routes/categories.tsx`, `apps/web-rr/app/routes/category.tsx`, `apps/api/src/domain/taxonomy.ts` | `apps/api/src/domain/taxonomy.test.ts`, `apps/web-rr/test/crawl-resources.test.ts` | partial — U-01 |
| Tags and hashtags | A signed-in author can create a Unicode hashtag, reuse an existing one, attach it to a work, and the tag page lists published works only. | `apps/web-rr/app/routes/tag.tsx`, `packages/web-ui/src/components/public/tag-view.tsx`, `packages/web-ui/src/lib/tag-pages.ts`, `packages/web-ui/src/lib/tag-discovery.ts` | `e2e/tags.spec.ts`, `e2e/tag-feeds.spec.ts`, `packages/web-ui/src/lib/tag-pages.test.ts` | verified |
| Tag and site feeds | A tag feed and the site feed contain only published works in the requested language, and only the latest bounded set. | `apps/web-rr/app/routes/tag-feed.ts`, `apps/web-rr/app/routes/site-feed.ts`, `packages/web-ui/src/lib/tag-feed.ts`, `packages/web-ui/src/lib/site-feed.ts` | `e2e/tag-feeds.spec.ts`, `apps/web-rr/test/tag-feed-response.test.ts`, `apps/web-rr/test/site-feed-response.test.ts` | verified |
| Public author profiles and the author directory | A public profile omits private account fields, lists published works only, and the directory is a bounded, paginated public list. | `apps/web-rr/app/routes/author.tsx`, `apps/web-rr/app/routes/authors.tsx`, `packages/web-ui/src/components/public/author-view.tsx`, `packages/web-ui/src/lib/author-profile.ts` | `e2e/authors.spec.ts`, `packages/web-ui/src/lib/author-profile.test.ts` | verified |
| SEO, sitemap and crawlable metadata | Public pages emit crawlable HTML with canonical, hreflang and Open Graph metadata; the sitemap is bounded and the public origin is validated. | `apps/web-rr/app/routes/sitemap.xml.ts`, `apps/web-rr/app/routes/robots.txt.ts`, `packages/web-ui/src/lib/site-metadata.ts`, `packages/web-ui/src/lib/sitemap-catalog.ts`, `packages/web-ui/src/lib/site-metadata.ts` | `apps/web-rr/test/crawl-resources.test.ts`, `apps/web-rr/test/crawl-publication.test.ts`, `packages/web-ui/src/lib/site-metadata.test.ts` | verified |

### Identity and accounts

| Capability | Acceptance requirement | Implementation | Verification | State |
| --- | --- | --- | --- | --- |
| Registration, login, logout and session refresh | A visitor can create an account, sign in, refresh the browser session without losing the signed-in actor, and sign out. Browser code never holds a long-lived token. | `apps/api/src/application/identity.ts`, `apps/web-rr/app/routes/sign-in.tsx`, `packages/web-ui/src/components/auth/sign-in-form.tsx`, `packages/web-http/src/index.ts`, `apps/web-rr/refresh/` | `e2e/session-refresh.spec.ts`, `apps/web-rr/test/refresh-session.test.ts`, `apps/web-rr/test/refresh-coordinator-node.test.ts`, `apps/api/src/application/identity.test.ts` | verified |
| Author profile editing | Only the current account can change its own profile; the public byline follows. | `packages/web-ui/src/components/authoring/author-profile-panel.tsx`, `packages/web-ui/src/lib/author-profile.ts`, `apps/api/src/application/identity.ts` | `e2e/authoring.spec.ts`, `packages/web-ui/src/lib/author-profile.test.ts` | verified |
| Account mail: verification and recovery | Verification and recovery exist end to end and stay switched off until an operator enables them; nothing is sent by default. | `apps/api/src/application/identity-mailer.ts`, `apps/web-rr/app/routes/forgot-password.tsx`, `apps/web-rr/app/routes/reset-password.tsx`, `apps/web-rr/app/routes/verify-email.tsx` | `apps/api/src/application/identity-mailer.test.ts`, `packages/web-ui/src/lib/mail-feature.test.ts` | verified |
| Device and session management | An account can list its sessions and end one or all of them; ending a session takes effect for later requests without waiting for a token to expire. | `apps/api/src/transport/rest/routes.ts`, `apps/api/src/application/identity.ts` | `e2e/devices.spec.ts`, `apps/api/src/application/identity.test.ts` | verified |
| Editorial roles | The editor role is distinct from any moderation capability, and an editor can grant editorial roles only. | `apps/api/src/application/services.ts`, `apps/api/src/transport/rest/routes.ts`, `apps/web-rr/app/routes/admin.featured.tsx` | `apps/api/src/application/roles.test.ts` | verified |

### Authoring and works

| Capability | Acceptance requirement | Implementation | Verification | State |
| --- | --- | --- | --- | --- |
| Create, edit, publish, withdraw and delete a work | Only the owner can mutate a work; a draft never appears publicly; deleting is recoverable and a later sweep can purge it. | `apps/api/src/application/article-create.ts`, `apps/api/src/application/article-idempotency.ts`, `packages/web-ui/src/components/authoring/article-editor.tsx`, `packages/web-ui/src/components/authoring/authoring-workspace.tsx` | `e2e/authoring.spec.ts`, `e2e/authoring-saving.spec.ts`, `apps/api/src/transport/rest/article-write.test.ts` | verified |
| Rich-text contract | The supported node set round-trips through the application contract, an unsupported node fails closed, and an unsafe URL is refused at the boundary. | `apps/api/src/domain/lexical-document-adapter.ts`, `apps/api/src/domain/article.ts`, `packages/web-ui/src/lib/lexical-article-state.ts` | `apps/api/src/domain/lexical-document-adapter.test.ts`, `apps/api/src/domain/lexical-web-compat.test.ts`, `packages/web-ui/src/lib/lexical-article-state.test.ts` | verified |
| Rich-text contract, browser round trip | The same document survives save, reload, a second edit and a second save with its block identifiers and structure intact, and a hostile scheme never becomes active content on the reading page. | `packages/web-ui/src/components/authoring/article-editor.tsx`, `packages/web-ui/src/components/comments/article-comments.tsx` | `e2e/authoring.spec.ts`, `e2e/comment-session.spec.ts` | partial — U-02 |
| Multilingual editions of one work | One work can carry several language editions, each independently editable and restorable, and a stale editor cannot overwrite a newer revision. | `apps/api/src/domain/edition-language.ts`, `apps/web-rr/app/routes/write.tsx`, `packages/web-ui/src/lib/authoring-catalogue-versions.ts` | `e2e/authoring-locale-and-stale-editor.spec.ts`, `apps/api/src/transport/rest/authoring-locales.integration.test.ts` | verified |
| Article catalogue, editions and versions | The author's own catalogue lists every work including deleted ones, with its editions, versions and restore path. | `apps/api/src/domain/article-catalogue.ts`, `apps/web-rr/app/routes/write.library.tsx`, `packages/web-ui/src/components/authoring/authoring-catalogue.tsx` | `e2e/authoring-catalogue.spec.ts`, `apps/api/src/transport/rest/article-catalogue.integration.test.ts` | verified |
| Media library and uploads | An author can upload an image, list it, delete it, and reference it in a work; an upload without configured object storage fails with a readable error rather than a silent one. | `apps/api/src/application/media-assets.ts`, `apps/web-rr/app/routes/write.media.tsx`, `packages/web-ui/src/components/authoring/media-library.tsx` | `e2e/media-library.spec.ts`, `e2e/media-security.spec.ts`, `apps/api/src/application/media-assets.test.ts` | verified |
| Featured shelf | A configured editorial shelf selects works by a recorded algorithm, and the shelf is visible only to the roles that may change it. | `apps/api/src/application/featured-algorithm.ts`, `apps/web-rr/app/routes/admin.featured.tsx`, `packages/web-ui/src/components/admin/featured-shelf-panel.tsx` | `apps/api/src/application/featured-algorithm.test.ts` | verified |
| Notion import and export | A dry run writes nothing; an apply reports per page; an export returns the author's own works as a bundle, and no Notion token is stored. | `apps/api/src/application/notion-import.ts`, `apps/api/src/application/notion-export.ts`, `apps/api/src/application/notion-oauth.ts`, `packages/web-ui/src/components/authoring/notion-import.tsx` | `e2e/notion-import.spec.ts`, `e2e/notion-fetch.spec.ts`, `e2e/notion-oauth.spec.ts`, `apps/api/src/transport/rest/imports.integration.test.ts` | verified |
| Durable Notion import jobs | A long import runs as a durable job that is off by default and can be drained, polled and cancelled. | `apps/api/src/application/notion-durable-jobs.ts`, `apps/api/src/application/notion-job-service.ts` | `e2e/notion-jobs.spec.ts`, `apps/api/src/persistence/notion-durable-jobs.integration.test.ts` | verified |
| Unsaved-draft recovery across refresh or navigation | A refresh, a navigation or a closed tab cannot silently lose the last input, and an unconfirmed create is never replayed into a duplicate work. | `packages/web-ui/src/lib/writing-recovery-controller.ts`, `packages/web-ui/src/lib/writing-session.ts`, `packages/web-ui/src/components/authoring/writing-recovery.tsx` | `e2e/writing-recovery.spec.ts`, `packages/web-ui/src/lib/writing-session.test.ts` | partial — U-03 |

### Community interaction

| Capability | Acceptance requirement | Implementation | Verification | State |
| --- | --- | --- | --- | --- |
| Follow and unfollow | No duplicate follows, no self-follow, and the count and state agree across every surface. | `packages/web-ui/src/components/public/author-follow.tsx`, `packages/web-ui/src/components/public/author-follow.tsx` | `e2e/engagement.spec.ts`, `packages/web-ui/src/lib/author-follow.test.ts` | verified |
| Likes (saves) | An explicit save state, consistent counts, and a late response cannot change another work's control. | `packages/web-ui/src/components/public/article-like.tsx`, `packages/web-ui/src/components/public/article-like.tsx` | `e2e/engagement.spec.ts`, `packages/web-ui/src/lib/article-like.test.ts` | verified |
| Comments and threaded replies | Only the author can edit or delete a comment, the thread paginates in reading order, and a deleted work tells the commenter in their own desk. | `packages/web-ui/src/components/comments/article-comments.tsx`, `packages/web-ui/src/lib/comment-edit.ts`, `apps/api/src/transport/rest/routes.ts` | `e2e/comment-session.spec.ts`, `apps/api/src/transport/rest/comment-edit.integration.test.ts`, `e2e/authoring.spec.ts` | verified |
| Moderation: reports, scoped holds and independent appeals | A reporter can report one work or one message they can read; an administrator sees only the submitted evidence; a hold is reversible; an appeal is decided by someone independent; every action is audited. | none — no moderation schema, migration, service, REST route, audit log or UI exists | none | open — U-04 |

### Direct messages

| Capability | Acceptance requirement | Implementation | Verification | State |
| --- | --- | --- | --- | --- |
| Conversation list and lifecycle | Conversation membership is enforced by the server, and a membership change or a deletion takes effect for later reads. | `apps/web-rr/app/routes/messages.tsx`, `packages/web-ui/src/components/public/messages-view.tsx`, `packages/web-ui/src/lib/messaging-transport.ts` | `e2e/messages.spec.ts`, `e2e/messaging-privacy.spec.ts`, `packages/web-ui/src/lib/messaging-transport.test.ts` | verified |
| Message history, send and unread state | The sender is server-derived, history paginates by cursor, unread state survives a reload, and a message is persisted independently of the recipient being online. | `packages/web-ui/src/components/public/thread-view.tsx`, `packages/web-ui/src/lib/messaging-transport.ts`, `apps/api/src/transport/rest/routes.ts` | `e2e/message-read.spec.ts`, `e2e/messaging-safety.spec.ts`, `apps/api/src/persistence/conversation-read-order.test.ts` | verified |
| Messaging intent and privacy | A message that mentions an unbound account is never delivered to the wrong person, and reading history is private to its owner. | `packages/web-ui/src/lib/messaging-intent.ts`, `packages/web-ui/src/lib/messaging-privacy.ts` | `e2e/messaging-privacy-intent.spec.ts`, `e2e/messaging-privacy-history.spec.ts`, `packages/web-ui/src/lib/messaging-privacy.test.ts` | verified |

### Notifications and real time

| Capability | Acceptance requirement | Implementation | Verification | State |
| --- | --- | --- | --- | --- |
| Notification inbox | The inbox is recipient-scoped and durable, read state is server-side, and a retry never duplicates a notification. | `packages/web-ui/src/lib/notification-transport.ts`, `packages/web-ui/src/lib/use-notification-inbox.ts`, `packages/web-ui/src/components/chrome/notification-provider.tsx` | `e2e/chrome-bell.spec.ts`, `e2e/notification-sync.spec.ts`, `e2e/notification-recovery-actor.spec.ts` | verified |
| Notification offline recovery | A notification produced while the browser was offline is still delivered and readable afterwards, and the inbox is restored to the right account. | `packages/web-ui/src/lib/notification-recovery.ts`, `packages/web-ui/src/lib/notification-controller.ts` | `e2e/notification-offline-recovery.spec.ts`, `e2e/notification-actor.spec.ts`, `packages/web-ui/src/lib/notification-recovery.test.ts` | verified |
| Real-time transport selection | A concrete need for SSE or WebSocket has been stated and validated; until then the persisted state and the outbox stay authoritative. | none — the browser uses bounded HTTP polling through `packages/web-ui/src/lib/notification-transport.ts` and `packages/web-ui/src/lib/messaging-transport.ts` | `e2e/notification-sync.spec.ts` | open — U-05 |

### Local-first reading and writing tools

| Capability | Acceptance requirement | Implementation | Verification | State |
| --- | --- | --- | --- | --- |
| Local reading shelf, continuing and in-page find | The shelf is local to the reader, isolated per account and device, and the continuation point can be previewed and refused before it is applied. | `packages/web-ui/src/components/reader/reading-list.tsx`, `packages/web-ui/src/components/reader/reading-shelf-provider.tsx`, `packages/web-ui/src/lib/reading-shelf-store.ts` | `e2e/reading-list.spec.ts`, `apps/web-rr/test/reading-list.test.ts`, `packages/web-ui/src/lib/reading-shelf-store.test.ts` | verified |
| Reader tools: find, read aloud and passage notes | Find is keyboard-reachable, read aloud does not fight the reader for focus, and a passage note belongs to the reader. | `packages/web-ui/src/components/reader/reader-find.tsx`, `packages/web-ui/src/components/reader/read-aloud.tsx`, `packages/web-ui/src/components/reader/passage-annotations.tsx` | `e2e/reader-find.spec.ts`, `e2e/read-aloud.spec.ts`, `e2e/passages.spec.ts` | verified |
| Local writing workbench (recovery, collections, overlap, terms, cadence, parallel, merge, vault) | Every tool is local, read-only or explicitly consented, never uploads, never publishes, never replays a request, and states its own limits. | `packages/web-ui/src/lib/writing-recovery-model.ts`, `packages/web-ui/src/lib/writing-merge-plan.ts`, `packages/web-ui/src/lib/writing-vault-payload.ts`, `packages/web-ui/src/lib/writing-overlap-model.ts`, `packages/web-ui/src/lib/writing-terms-model.ts`, `packages/web-ui/src/lib/writing-cadence-model.ts`, `packages/web-ui/src/lib/writing-parallel-model.ts` | `e2e/writing-recovery.spec.ts`, `e2e/writing-collections.spec.ts`, `e2e/writing-overlap.spec.ts`, `e2e/writing-terms.spec.ts`, `e2e/writing-cadence.spec.ts`, `e2e/writing-parallel.spec.ts`, `e2e/writing-merge.spec.ts`, `e2e/writing-vault.spec.ts` | verified |

### Operations and interchange

| Capability | Acceptance requirement | Implementation | Verification | State |
| --- | --- | --- | --- | --- |
| Scheduled maintenance | Expired sessions, closed rate-limit windows and expired tombstones are pruned by a one-shot process a scheduler can run, with bounded exit codes. | `apps/api/src/application/maintenance.ts`, `apps/api/src/persistence/maintenance.ts`, `docs/operations/scheduled-maintenance.md` | `apps/api/src/application/maintenance.test.ts` | verified |
| Observability | The API writes structured logs, exposes process-local Prometheus metrics that are off by default, and never returns internal configuration. | `apps/api/src/infrastructure/http-observability.ts`, `apps/api/src/infrastructure/http-lifecycle.ts`, `docs/operations/api-observability.md` | `apps/api/src/infrastructure/http-observability.test.ts` | verified |
| Finite read-only operational monitor | The monitor performs bounded read-only checks, raises a named rule when a threshold is crossed, and never repairs or re-delivers by itself. | `apps/api/src/application/operational-monitor.ts`, `apps/api/src/infrastructure/monitor-command.ts` | `apps/api/src/application/operational-alerts.test.ts`, `apps/api/src/application/operational-monitor-status.test.ts`, `scripts/phase-gate-disposition.test.ts` | verified |
| Offline signed alert handoff and evidence review | An offline alert is handed over with a durable receipt, verified by public key, and reconciled read-only; a signed record never becomes an alert that reached a person. | `apps/api/src/application/alert-handoff-protocol.ts`, `apps/api/src/application/alert-handoff-inbox.ts`, `apps/api/src/application/alert-evidence.ts` | `apps/api/src/application/alert-handoff.test.ts`, `apps/api/src/application/alert-evidence.test.ts` | verified |
| Persistence provider and online cutover | SQLite and PostgreSQL behave the same, and an online cutover captures, replays, reconciles and fences changes instead of switching a configuration string. | `apps/api/src/application/persistence-ports.ts`, `apps/api/src/persistence/sqlite-store.ts`, `apps/api/src/persistence/migrations` | `apps/api/src/persistence/persistence-adapter-contract-reads-and-references.test.ts`, `apps/api/src/persistence/migrate.test.ts` | partial — U-06 |

### Accessibility, security and platform

| Capability | Acceptance requirement | Implementation | Verification | State |
| --- | --- | --- | --- | --- |
| Accessibility | The reading and writing surfaces have no serious axe violation, the first keyboard stop is discoverable, and controls have reachable touch targets. | `packages/web-ui/src/components/ui/parts.tsx`, `packages/web-ui/src/styles/globals.css` | `e2e/accessibility.spec.ts`, `e2e/chrome-focus.spec.ts` | partial — U-07 |
| Editor accessibility and keyboard operation | The article and comment editors can be operated and understood with a keyboard alone, and the mobile viewport keeps the editor usable with a software keyboard. | `packages/web-ui/src/components/authoring/article-editor.tsx`, `packages/web-ui/src/components/comments/article-comments.tsx` | `e2e/accessibility.spec.ts`, `e2e/mobile-overflow.spec.ts` | partial — U-08 |
| Browser security policy | Inline handlers, base and object elements, framing and cross-origin exfiltration are blocked by the response policy rather than by input filtering. | `apps/web-rr/app/lib/` | `e2e/browser-security.spec.ts`, `apps/web-rr/test/document-security.test.ts` | verified |
| Private response isolation | A private response is never written to a shared cache, and private content does not leak into a public document. | `packages/web-http/src/index.ts`, `apps/web-rr/test/cache-policy.test.ts` | `apps/web-rr/test/cache-policy.test.ts`, `e2e/private-cls.spec.ts` | verified |
| Progressive web app and offline reading | The site is installable and the reading surface survives an offline visit under an explicit cache and privacy rule. | none — no web manifest, service worker or offline cache exists | none | open — U-09 |
| Future mobile and desktop clients | A React Native or Tauri client reuses the API and authentication contracts instead of forking shared behaviour. | none | none | open — U-10 |

## The product reference

The table above is the new implementation. The previous product is a behavioural
reference rather than a constraint: a capability is carried over because a reader or
author needs it, not because the old code had a particular shape. The legacy
inventory that these rows answer to lives in the archived audits
[backend review](../audit/backend-review-2026-11.md) and
[frontend findings](../audit/legacy-frontend-findings.md).

## Maintenance

`scripts/feature-traceability.test.ts` keeps this file honest. It fails when

- a capability row cites an implementation or verification path that does not exist;
- a cited verification path is a test file with no test case in it;
- a row is `partial` or `open` without citing a `U-xx` id, or cites an id that the
  companion document does not define;
- the companion document defines an id that no row cites, so a decision cannot be
  recorded and then quietly forgotten;
- a capability row has no verification evidence at all.

Adding a capability therefore means adding its implementation and its test in the
same change. Removing a capability means removing its evidence.
