# Architecture decision records

One numbered file per decision. The number is **permanent**: a decision that is
replaced says so in its own `Status` line and stays where it is, so every link in
the repository keeps pointing at the same decision, and nobody has to remember
which of two `0011`s meant what.

| # | Decision | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-monorepo-and-service-boundaries.md) | Monorepo and Service Boundaries | Accepted | 2026-10-22 |
| [0002](0002-web-framework-evaluation.md) | Select Next.js App Router for the Web Application | Superseded | 2026-10-23 |
| [0003](0003-graphql-api-runtime.md) | GraphQL API runtime | Superseded | 2026-10-23 |
| [0004](0004-durable-domain-persistence.md) | PostgreSQL as the new product's system of record | Superseded | 2026-10-24 |
| [0005](0005-clean-architecture-and-replication.md) | Clean Architecture and provider-independent persistence | Accepted | 2026-10-24 |
| [0006](0006-rest-only-business-api.md) | REST-only business API | Accepted | 2026-10-27 |
| [0007](0007-lexical-rich-text-editors.md) | Lexical for article and comment editors | Accepted | 2026-10-27 |
| [0008](0008-self-hosted-api-identity.md) | Self-hosted identity in the independent API | Accepted | 2026-10-28 |
| [0009](0009-message-notification-recipient-timing.md) | Message notification recipients at delivery time | Accepted | 2026-10-28 |
| [0010](0010-sqlite-first-and-online-provider-cutover.md) | SQLite-first persistence and online provider cutover | Accepted | 2026-10-28 |
| [0011](0011-persistent-api-write-rate-limits.md) | Persistent API write rate limits | Accepted | 2026-10-28 |
| [0012](0012-portable-web-framework-migration.md) | Migrate Web to React Router 7 Framework Mode | Accepted | 2026-10-29 |
| [0013](0013-article-slug-and-summary-generation.md) | Generated article slugs and automatic summaries | Accepted | 2026-10-29 |
| [0014](0014-password-recovery-and-email-verification.md) | Password recovery and email verification | Accepted | 2026-10-30 |
| [0015](0015-transactional-mail-over-a-generic-smtp-relay.md) | Transactional mail over a generic SMTP relay | Accepted | 2026-10-31 |
| [0016](0016-editorial-taxonomy-and-editor-role.md) | Editorial taxonomy control and the editor role | Accepted | 2026-11-01 |
| [0017](0017-nextjs-retired-one-web-application.md) | Next.js is retired; one Web application | Accepted | 2026-11-01 |
| [0018](0018-session-id-on-access-tokens.md) | An access token names its session, and a password change is one operation | Accepted | 2026-11-01 |
| [0019](0019-device-list-without-device-fingerprints.md) | A device list with no device fingerprints | Accepted | 2026-11-01 |
| [0020](0020-read-aloud-stays-in-the-browser.md) | Read-aloud stays in the browser | Accepted | 2026-11-01 |
| [0021](0021-reading-marks-stay-on-the-readers-device.md) | Reading marks stay on the reader's device | Accepted | 2026-11-01 |
| [0022](0022-media-library-without-scheduled-reclamation.md) | The media library marks orphans; reclamation is a person's decision | Accepted | 2026-11-02 |
| [0023](0023-a-shared-passage-is-a-link-not-a-record.md) | A shared passage is a link, not a record | Accepted | 2026-11-02 |
| [0024](0024-authors-are-a-directory-not-a-side-effect-of-works.md) | Authors are a directory, not a side effect of their works | Accepted | 2026-11-02 |
| [0025](0025-browser-session-refresh-protocol.md) | The browser session is one cookie contract and one refresh per rotation | Accepted | 2026-11-04 |
| [0026](0026-moderation-reports-and-appeals.md) | Reports, scoped moderation and independent appeals | Accepted | 2026-11-05 |
| [0027](0027-client-address-behind-a-proxy.md) | The client address is the socket peer unless the deployment names its proxies | Accepted | 2026-11-07 |
| [0028](0028-s3-compatible-media-storage.md) | Server-mediated uploads to S3-compatible media storage | Accepted | 2026-10-29 |
| [0029](0029-one-deployment-path.md) | One deployment path — the repository ships no platform manifest | Accepted | 2026-11-07 |
| [0030](0030-body-search-generated-column.md) | Body search reads a generated column, not the JSON blocks | Accepted | 2026-11-07 |
| [0031](0031-comment-edits.md) | A comment edit replaces the words and nothing else | Accepted | 2026-11-08 |
| [0032](0032-comment-thread-depth.md) | A comment thread has a bottom, and the reader sees all of it | Accepted | 2026-11-09 |
| [0033](0033-off-line-database-copy.md) | Moving a database means an off-line copy, and the target starts empty | Accepted | 2026-11-09 |
| [0034](0034-comment-thread-pagination.md) | A thread pages by top-level comment, and a reply travels with its root | Accepted | 2026-11-09 |
The status column carries the leading word of each file's `- Status:` line —
read the file for the qualifier ("Superseded by ADR 0012", "Accepted as the
initial direction").

`pnpm test` holds this page honest (`scripts/adr-index.test.ts`): the numbers
are unique and contiguous, each file's `# ADR NNNN:` heading agrees with its
filename, every row above matches the file it links to, and every relative link
between decisions resolves. A new decision is one new file plus one new row.

A `Date` is when a decision was written, not when it became the latest word. A
decision that is replaced keeps its number and date and gains a `Superseded by`
status; a decision that was renumbered keeps its original date too — 0028 was
filed as a second `0011` on 2026-10-29 and renumbered on 2026-11-07.
