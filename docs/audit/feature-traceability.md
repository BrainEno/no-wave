# Feature Traceability — New Implementation

This is an evolving capability map based on selected legacy code review and implemented new API routes. Legacy code is evidence of product features and possible behavior, not an implementation constraint. Items marked conditional or uncertain must be verified rather than assumed.

| Capability | Functional reference | New implementation acceptance requirement | Current state |
|---|---|---|---|
| Public home/article listing | Legacy home/blog list and `listBlogsWithCatTag` | Published content is crawlable; search/filter/pagination are explicit; drafts never leak | Web fixture only; API-backed Web pending |
| Article detail and related content | Legacy article route, `getBlogBySlug`, `getRelatedBlogs` | Localized SEO metadata, valid 404, published state, structured content and related content | API core exists; Web fixture only |
| Categories | Legacy category routes/resolvers | Category listing/filtering and ownership/admin policy must be defined | Dynamic taxonomy API exists; category policy needs confirmation |
| Tags / hashtags | Legacy tag routes and tag resolvers; updated product requirement | Signed-in user can create a Unicode hashtag, normalized duplicates reuse the same global tag, any author can attach it to their article, tag detail only lists published localized articles | API implemented with PostgreSQL integration tests; Web UI pending |
| Public author profiles | Legacy public profile and author content | Public profile must omit private account fields; list only published article content | API profile/follow core; Web fixture only |
| Registration/login/logout/session refresh | Legacy auth pages/hooks and resolvers | New issuer/token contract, secure session lifecycle and no token logging | JWT verification/session revocation; issuer and Web auth UI pending |
| Profile editing | Legacy profile/dashboard | Only current user or authorized admin can change fields | API profile mutation owner-scoped by JWT; Web UI pending |
| Follow/unfollow | Legacy follow hooks/resolvers | No duplicates/self-follows; correct counts/state across clients | API implemented/tested |
| Likes/comments | Legacy like/comment UI/resolvers | Authenticated mutations, consistent counts, reply threading, ownership, notifications | API implemented/tested |
| Article create/edit/publish/delete | Legacy dashboard/edit routes | Owner/admin authorization, draft isolation, slug uniqueness, content validation | API create/update/publish; delete/edit UI pending |
| Rich-text/media editor | Legacy editor and upload helpers | Structured content contract, safe rendering, server-side node/URL validation, upload validation and lossless serialization | Lexical selected for both article and comment editors (ADR 0007); editor UI, schema adapter, comment contract and upload integration pending |
| Conversation list/lifecycle | Legacy chat components/resolvers | Membership and management rules server-enforced | API implemented/tested |
| Message history/send/unread state | Legacy chat UI and resolvers | Server-derived sender, persistence, cursor history and offline recovery | API core implemented/tested |
| Real-time updates | Legacy SSE/subscriptions | Reconnect reads persisted state; events are hints, not source of truth | Outbox core; browser realtime integration pending |
| Notification inbox | Legacy notification store/subscriptions | Recipient-scoped durable state, read state, idempotent retries | API implemented/tested; external delivery pending |
| Localization | Existing locale resources | Traditional Chinese-first design plus English text expansion, metadata and route behavior | Web fixture localized; API content supports `zh-TW`/`en` |
| PWA/offline | Legacy manifest and service worker | Explicit cache/privacy rules, installability and recoverable offline state | Pending |
| SEO/sitemap/analytics | Legacy metadata/sitemap helpers | Crawlable HTML, canonical/OG/hreflang and sitemap; analytics configurable | Web fixture SEO implemented; API-backed sitemap pending |
| Future mobile/desktop | Product direction | Reuse API/domain contracts, not force shared UI | Later phase |

## Traceability workflow

For each capability, record exact legacy evidence, observed behavior, uncertainty, new API/schema operation, Web route, BDD acceptance test and operational implications. Label something verified only after source/runtime evidence is reviewed.
