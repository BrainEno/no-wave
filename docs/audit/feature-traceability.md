# Feature Traceability — New Implementation

This is an evolving capability map based on selected legacy code review and implemented new API routes. Legacy code is evidence of product features and possible behavior, not an implementation constraint. Items marked conditional or uncertain must be verified rather than assumed.

| Capability | Functional reference | New implementation acceptance requirement | Current state |
|---|---|---|---|
| Public home/article listing | Legacy home/blog list and `listBlogsWithCatTag` | Published content is crawlable; search/filter/pagination are explicit; drafts never leak | API-backed SSR listing and search; [routes](../../apps/web-rr/app/routes.ts), [public loaders](../../packages/web-ui/src/lib/public-pages.ts) |
| Article detail and related content | Legacy article route, `getBlogBySlug`, `getRelatedBlogs` | Localized SEO metadata, valid 404, published state, structured content and related content | API-backed SSR detail and hard 404; [route](../../apps/web-rr/app/routes/article.tsx), [reader](../../packages/web-ui/src/components/public/article-view.tsx) |
| Categories | Legacy category routes/resolvers | Category listing/filtering and ownership/admin policy must be defined | Dynamic taxonomy API exists; category policy needs confirmation |
| Tags / hashtags | Legacy tag routes and tag resolvers; updated product requirement | Signed-in user can create a Unicode hashtag, normalized duplicates reuse the same global tag, any author can attach it to their article, tag detail only lists published localized articles | API implemented with PostgreSQL integration tests; Web UI pending |
| Public author profiles | Legacy public profile and author content | Public profile must omit private account fields; list only published article content | API-backed SSR author pages and follow control; [route](../../apps/web-rr/app/routes/author.tsx), [follow](../../packages/web-ui/src/components/public/author-follow.tsx) |
| Registration/login/logout/session refresh | Legacy auth pages/hooks and resolvers | New issuer/token contract, secure session lifecycle and no token logging | Initial self-hosted API registration/login, rotation and logout tested; email verification and password recovery implemented end to end and shipped switched off behind `MAIL_ENABLED` (docs/operations/mail-setup.md); browser storage, production hardening pending |
| Profile editing | Legacy profile/dashboard | Only current user or authorized admin can change fields | Owner-scoped API and writing desk [profile panel](../../packages/web-ui/src/components/authoring/author-profile-panel.tsx) |
| Follow/unfollow | Legacy follow hooks/resolvers | No duplicates/self-follows; correct counts/state across clients | API and Web controls implemented; [engagement E2E](../../e2e/engagement.spec.ts) |
| Likes/comments | Legacy like/comment UI/resolvers | Authenticated mutations, consistent counts, reply threading, ownership, notifications | API and Web controls implemented; [engagement E2E](../../e2e/engagement.spec.ts) |
| Article create/edit/publish/delete | Legacy dashboard/edit routes | Owner/admin authorization, draft isolation, slug uniqueness, content validation | API and writing desk implement create, edit, publish, delete and restore; [authoring E2E](../../e2e/authoring.spec.ts) |
| Rich-text/media editor | Legacy editor and upload helpers | Structured content contract, safe rendering, server-side node/URL validation, upload validation and lossless serialization | Lexical article/comment editors and upload path exist; [article editor](../../packages/web-ui/src/components/authoring/article-editor.tsx), [comment editor](../../packages/web-ui/src/components/comments/article-comments.tsx); losslessness and accessibility remain separate acceptance concerns |
| Conversation list/lifecycle | Legacy chat components/resolvers | Membership and management rules server-enforced | API and Web controls implemented; [engagement E2E](../../e2e/engagement.spec.ts) |
| Message history/send/unread state | Legacy chat UI and resolvers | Server-derived sender, persistence, cursor history and offline recovery | API-backed message history/send UI; [E2E](../../e2e/messages.spec.ts) |
| Real-time updates | Legacy SSE/subscriptions | Reconnect reads persisted state; events are hints, not source of truth | Outbox core; browser realtime integration pending |
| Notification inbox | Legacy notification store/subscriptions | Recipient-scoped durable state, read state, idempotent retries | API and Web inbox exist; [notification E2E](../../e2e/chrome-bell.spec.ts); external delivery pending |
| Localization | Existing locale resources | Traditional Chinese-first design plus English text expansion, metadata and route behavior | Public Web routes offer `zh-CN` and `en`; API stores `zh-CN`/`zh-TW`/`en`; full Traditional Chinese Web coverage remains unverified |
| PWA/offline | Legacy manifest and service worker | Explicit cache/privacy rules, installability and recoverable offline state | Pending |
| SEO/sitemap/analytics | Legacy metadata/sitemap helpers | Crawlable HTML, canonical/OG/hreflang and sitemap; analytics configurable | API-backed sitemap and metadata; [route](../../apps/web-rr/app/routes/sitemap.xml.ts), [metadata](../../packages/web-ui/src/lib/site-metadata.ts); analytics configurable status needs review |
| Future mobile/desktop | Product direction | Reuse API/domain contracts, not force shared UI | Later phase |

## Traceability workflow

For each capability, record exact legacy evidence, observed behavior, uncertainty, new API/schema operation, Web route, BDD acceptance test and operational implications. Label something verified only after source/runtime evidence is reviewed.
