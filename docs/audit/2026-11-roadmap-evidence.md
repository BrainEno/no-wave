# Roadmap evidence review

This review reconciles the current tree with the phase-gate checklist for #276.
A checked item means the specific capability described in that item has source
and test evidence; it does not mean a phase exit gate or production deployment
has been approved. Links establish where to review the evidence, not that every
runtime scenario has been exercised in this review.

## Decisions made in this pass

### Visual direction

The [design system](../../packages/web-ui/docs/UI_DESIGN_SYSTEM.md) records the
approved direction and the principal tokens. The direction decision is no
longer waiting for a forthcoming brief, so the decision item is checked.
Implementing every detail and verifying each breakpoint are separate tasks.

### Web route migration

[ADR 0017](../architecture/decisions/0017-nextjs-retired-one-web-application.md)
records retirement of the old Web app after the replacement route and HTTP tests.
The current [route table](../../apps/web-rr/app/routes.ts) registers the account,
writing, comment and media routes, and [Web tests](../../apps/web-rr/test/web.test.ts)
exercise route/proxy contracts. This supports checking the migration item; it
is not evidence that a production host or traffic rollback has been rehearsed.

### Article editor and recovery

The [article editor](../../packages/web-ui/src/components/authoring/article-editor.tsx)
has editing, explicit saves and an image-upload flow, with a browser journey in
[authoring E2E](../../e2e/authoring.spec.ts). The original checklist combined
that implemented work with draft recovery. These are now separate items: the
editor only retains an unconfirmed request in the current page and warns against
refreshing. It does not promise persistent recovery of unsaved edits. The
remaining rich-text, IME and accessibility acceptance is also not checked here.

### Account interfaces versus parity

The [account](../../apps/web-rr/app/routes/account.tsx) and
[sign-in](../../apps/web-rr/app/routes/sign-in.tsx) routes exist, with HTTP tests
in [web.test.ts](../../apps/web-rr/test/web.test.ts). The checklist now separates
those interfaces from the broader feature-parity journey. The existence of a
route is not a security audit or a production-readiness certification.

## Items deliberately left open

These notes are not new product decisions. They explain why existing unchecked
items were not marked complete merely because adjacent functionality exists.

### Traceability and design

- The [feature map](feature-traceability.md) is useful but calls itself evolving;
  it is not yet the full feature-by-feature legacy and acceptance inventory.
- The [design system](../../packages/web-ui/docs/UI_DESIGN_SYSTEM.md) describes
  both implemented route names and design targets. It explicitly labels the
  proposed submission steps as a proposal, not an existing submission route.
- Agreement on visual direction does not prove complete implementation of every
  Cloud design artifact across all screen sizes and states.

### Identity and editing

- [Mail setup](../operations/mail-setup.md) documents verification and recovery,
  disabled by default. This does not resolve browser storage and operational
  hardening for production.
- The editor's image upload does not, by itself, prove preservation of every
  additional Lexical metadata field or settle a future custom-node contract.
- The [Lexical adapter tests](../../apps/api/src/domain/lexical-document-adapter.test.ts)
  cover serialization and invalid inputs. They do not establish the complete
  IME, keyboard, mobile and accessibility acceptance in the combined gate.
- Saved server drafts and in-page retry are not the same as restoring unsaved
  editor state after a reload. That recovery task remains open.

### Persistence and cutover

- SQLite and PostgreSQL adapters are supported; a MongoDB adapter is not implied
  by the [provider architecture](../architecture/decisions/0010-sqlite-first-and-online-provider-cutover.md).
- A working operation on both providers does not establish complete cross-provider
  contract parity or all provider-specific failure semantics.
- The [offline copy decision](../architecture/decisions/0033-off-line-database-copy.md)
  explicitly distinguishes an offline copy from online change capture, fenced
  cutover, replay and reconciliation. The latter remain open.
- Existing configuration and API/Web tests are evidence for particular paths,
  not proof that every configuration/runtime gap has been eliminated.

### Taxonomy and community

- [Category routes](../../apps/web-rr/app/routes.ts) provide public browsing;
  ownership, creation and moderation policy still require product decisions.
- The API has taxonomy operations, but the route table does not register a
  public hashtag index/detail route. The combined hashtag gate remains open.
- [Message E2E](../../e2e/messages.spec.ts) and
  [notification E2E](../../e2e/chrome-bell.spec.ts) cover real journeys. They do
  not prove browser reconnect/offline recovery or an external delivery provider.
- A notification unread total can include unloaded rows; see #267. Pagination
  and a mark-all button do not establish equality with the currently visible rows.

### Operations and hosting

- [Host qualification](../operations/host-qualification.md) records the
  checks required for a candidate; it is not proof that an actual candidate has
  passed signup, cost, sleep, storage and worker checks.
- [Observability](../operations/api-observability.md) documents metrics and
  probes; full delivery alert thresholds and recovery drills remain separate.
- The [portable stack](../operations/portable-stack.md) and CI exercise local
  startup. They do not imply production deployment or a traffic cutover.
- The [notification worker runbook](../operations/notification-worker.md)
  describes operation; that does not by itself verify all recovery drills.
- A [Notion interchange design](../architecture/decisions/0036-notion-as-interchange-format.md)
  exists, but this does not approve an actual historical data import execution.
- HA, standby, external push and future mobile/desktop clients remain decisions
  or future work, not outcomes of the existing single-host setup.

## Review boundaries

The issue refers to 17 implemented unchecked items but does not include their
identities or the full original audit text. This review does not infer which 17
were intended. Items were changed only where the current tree and acceptance
could be distinguished; combined gates were split instead of marking an entire
phase complete. Supply the missing original list to finish a line-by-line
comparison with the review.

The local evidence guard checks relative Markdown links, including reference
links and images, against repository paths. It deliberately does not check
external URLs, application routes or heading anchors. It verifies existence,
not that a linked file proves the surrounding claim; human review remains
necessary.
