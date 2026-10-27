# BOT THK Product Behavior Baseline

Status: Initial capability baseline. Verify each item against the previous product before treating the inventory as exhaustive.

The previous project provides the reference for user-visible capabilities and known behaviors. The new implementation should cover those capabilities but does not have to retain unsafe code, old schemas, implementation patterns or accidental bugs. When an improvement would change product behavior, authorization policy, destructive lifecycle rules or compatibility expectations, first explain the options and risks and ask for approval.

## Public content

- Visitors can browse published articles and article details without signing in.
- Visitors can browse public author profiles and published content by an author.
- Article/author pages provide meaningful titles, descriptions, canonical/share metadata and crawlable HTML.
- Search, categories, tags, related articles and public comments remain available where supported.
- Draft and unpublished content is not exposed in public queries.
- Article bodies support structured blocks rather than assuming every article is a single plain-text field.
- The article editor and comment editor use Lexical as the shared editing framework, with different allowed-node and feature configurations. The application-owned, versioned document contract—not raw HTML or an unvalidated editor payload—is authoritative; see [ADR 0007](../architecture/decisions/0007-lexical-rich-text-editors.md).

## Categories and user-generated hashtags

- Categories and tags are separate taxonomy kinds with localized display labels.
- Hashtags are not a fixed enum or static list. Authenticated users can create hashtags dynamically, including Traditional Chinese and other supported Unicode letters/numbers.
- Hashtag creation normalizes equivalent forms such as an optional leading `#`, full-width forms and case variants; duplicate creation should reuse one global tag rather than create per-user duplicates.
- Authors can reuse community hashtags when creating or updating their own articles.
- Public hashtag pages list only published articles with the requested locale; drafts must not leak through taxonomy queries.
- The current tag creator/deletion policy and category creation/moderation policy require an explicit product decision before changing the existing behavior. Deleting a shared tag may affect several articles, so destructive lifecycle rules must not be broadened without approval.

## Accounts and profiles

- Users can register, sign in/out, refresh sessions and recover/reset passwords, subject to the verified product inventory.
- Users can view/edit permitted profile fields; public profile data is separate from private account data.
- Client-supplied user IDs cannot impersonate another user.

## Social features

- Users can follow/unfollow other users; state is consistent without duplicate relationships.
- Users can like/unlike articles and add/reply to comments where permitted.
- Mutations enforce authentication and resource-level ownership on the server.
- Notifications for follow, like, comment and reply are emitted according to approved product behavior; duplicate retries do not produce duplicate logical events.

## Messaging

- Authenticated participants can create/access conversations according to the approved product rules.
- Only participants can read history, send messages, change read state or manage participants where authorized.
- Sender identity comes from authenticated server context rather than a client-supplied sender ID.
- Messages persist while recipients are offline; reconnection retrieves authoritative history and unread state.
- Retries and concurrent actions do not corrupt state or create duplicate logical messages.

## Notifications

- Notifications have a recipient, stable identity, creation time and read state.
- Persisted notification history is the source of truth; real-time/push delivery does not replace persistence.
- Push delivery is best effort and must not imply the user has seen a notification.
- Push permissions are opt-in and revocable.

## Cross-cutting

- Private data is never exposed through public endpoints or shared caches.
- Errors remain visible and actionable; failed writes do not appear successful.
- Web UI remains usable on mobile and supports Traditional Chinese as the design baseline and English without broken layouts.
- PWA/offline behavior is specified separately from guaranteed background delivery.
- Future mobile/desktop clients share API contracts and domain rules but can use platform-specific UI.

## Traceability

Link each behavior to legacy evidence, acceptance tests, new implementation modules and any release/deployment requirements. Mark uncertainty explicitly instead of guessing.
