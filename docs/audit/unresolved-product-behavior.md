# Unresolved product behaviour

Status: active

This file records the product behaviours that are not finished, and for each one
the exact question that has to be answered before it can be implemented. It is the
companion to the [feature traceability map](feature-traceability.md): a capability
row that is not `verified` points at one of the entries here.

Two things are tracked in one place on purpose. Some entries are waiting for a
product decision that only the owner can make; others are gaps that the repository
can close on its own. Mixing them in a single register is deliberate — it keeps
"waiting for a decision" and "not built yet" from being confused with each other,
which is how a roadmap quietly stops moving.

## How the classes work

The classes are the ones already used by the
[phase-gate disposition](../roadmap/phase-gate-disposition.md).

| Class | Meaning | Who moves it |
| --- | --- | --- |
| **A** | The repository can close this without a product decision. | An implementation change in this repository. |
| **B** | A product decision is required first. | The owner. |
| **C** | It needs a real account, host or external service. | Outside the repository. |

Each entry states the question in a form that can be answered, the options that
were considered, what is blocked until it is answered, and where it is tracked.

---

## U-01 — Category ownership and tag deletion rules

**Class: B — product decision** · Tracked as roadmap item 11 (Phase 2) and related
to issue #415.

**The question.** Who may create a category, who owns a category once it exists,
and what happens to a tag that is attached to works when somebody wants to remove
it?

**Why it is open.** The API can read categories and tags, and an author can create
and attach a hashtag. Nothing in the contract says who may *create* a category, and
nothing says whether removing a tag is a delete, a rename, or a deprecation. The
moderation design treats editorial control and moderation control as two different
capabilities, so "an editor may delete a tag" is a decision, not a consequence.

**Options.**

- **B1 — Categories are editorial.** Only accounts in the editor allowlist may
  create, rename or retire a category. Tags are author-created and are never
  deleted; a tag can be merged into another tag, with the works keeping their
  visible name.
- **B2 — Categories are author-created.** Any signed-in author may create a
  category; it is public from the moment it is used. Tags are author-created and
  removable by their creator while unused.
- **B3 — Read-only for now.** Categories and tags are created only through an
  operator action. Nothing in the product surface offers creation.

**Recommended.** B1. The category list is part of the public navigation, and a
category nobody owns is a category nobody curates. The merge-instead-of-delete rule
for tags keeps a published work's text intact, which matters for a product whose
promise is that a published work stays readable.

**Blocked until answered.** Creating, renaming or retiring categories; any
deletion path for tags; the moderator-facing half of issue #415.

---

## U-02 — Rich text survives a second save, and a hostile scheme stays inert

**Class: A — the repository can close this** · Tracked as an unchecked item in
[Phase 0](../roadmap/phase-gates.md) and by issue #415's threat model (T15).

**The question.** Does a document keep its structure and its block identifiers
through save → reload → edit → save, and can a scheme that the API refuses still
reach a reader through an older row?

**Why it is open.** The server-side adapter is well covered: the application
contract round-trips its supported node set and fails closed on anything else, and
an unsafe URL is refused at the boundary
(`apps/api/src/domain/article.ts`, `apps/api/src/domain/lexical-document-adapter.ts`).
What is missing is the browser-level proof. No test drives a document through the
real API twice and compares the two results, and no test renders a work whose
stored content carries a hostile scheme and asserts that nothing active reaches the
reader.

**Blocked until answered.** Nothing is blocked: this is a verification gap, not a
decision. The traceability row for the rich-text browser round trip stays `partial`
until the tests exist.

---

## U-03 — Where an unsaved draft lives, and for how long

**Class: B — product decision** · Tracked as issue #418, roadmap item 5 (Phase 0)
and item 2 (the production-readiness gate).

**The question.** When a writer refreshes the page or closes the tab, where does
the unsaved input go, how long does it stay, and who can see it?

**Options.**

- **B1 — Server-side drafts.** The input is written to a server draft owned by the
  account. It survives any device, needs a migration and a retention policy, and
  the reader's private data now lives on the server.
- **B2 — Local-only, explicitly enabled.** The input stays in the browser's own
  storage, as today: off by default, per account and per device, cleared on sign
  out. A writer who wants durability opts in, and the product says plainly that it
  is a local copy.
- **B3 — Local-only, always on.** The input is always written locally without an
  opt-in, and the account switch clears it.

**Recommended.** B2. It matches what the repository already does — the local
recovery store exists, is off by default, and is fenced per account — and it
avoids creating a second persistence surface for a body of text that has not been
written yet. What B2 still needs is the honest labelling the issue asks for: a
before-leaving warning, a preview before restoring, and copy that never claims a
guarantee the store cannot keep.

**Blocked until answered.** Server-side draft storage; the final wording of the
writing desk's recovery promises; closing issue #418.

---

## U-04 — Reports, scoped holds and independent appeals

**Class: B — product decision** · Tracked as issue #415 and
[ADR 0026](../architecture/decisions/0026-moderation-reports-and-appeals.md).
The ADR's design was accepted; its implementation was never authorized.

**The question.** Seven decisions remain open in ADR 0026 §9. Each one needs an
answer before the first migration is written.

| Gate | What has to be decided |
| --- | --- |
| P1 | The reason taxonomy and the reviewer rubric, so that a report count never becomes a verdict on its own. |
| P5 | The evidence key lifecycle, and how evidence and its deletion behave in backups and in the provider-migration journal. |
| P6 | The objective for cache propagation after a hold, and the separate process for a shared media asset. |
| P7 | The hold semantics per target type, what a subject may see of the evidence, and the duplicate and merge rules for reports. |
| P8 | The legal and privacy basis, the jurisdictional obligations, and the exceptions to a deletion request. |
| P9 | The maximum duration of an upheld hold, its reassessment, and how it ends. |
| P10 | How reviewer independence is verified once a conversation's membership has been deleted. |

**Why it is open.** These are decisions about data, law and operations. They
cannot be closed in code review, and the ADR says so directly: until each is
resolved, or explicitly converted into a documented operational gate, the answer to
"can we ship this?" is no.

**Recommended.** Answer P8, P9 and P10 as product decisions with an operational
gate attached where no legal answer is available; answer P1, P5, P6 and P7 as
engineering decisions against the threat model's existing controls (A1–A15). The
platform should not be announced as an open public community until this entry is
closed, whether by implementation or by an explicit, recorded deferral.

**Blocked until answered.** Every moderation schema, migration, service, REST
route, audit log and user interface. Nothing else in the product depends on it.

---

## U-05 — Whether a real-time transport is needed at all

**Class: B — product decision** · Tracked as roadmap item 3 (Phase 0, REST-only
API section).

**The question.** Is there a concrete need for SSE or WebSocket, and if so, which
one?

**Why it is open.** The browser currently polls through bounded HTTP requests.
That is a deliberate default, not an oversight: the persisted state and the outbox
stay authoritative, and a transport is only a delivery mechanism. The roadmap
leaves the selection open because no approved real-time scenario exists yet.

**Options.**

- **B1 — Keep polling.** No new transport. The unread badge refreshes on an
  interval and on focus.
- **B2 — SSE.** One server-sent-events stream per signed-in browser, delivering
  hints that tell the client to re-read persisted state.
- **B3 — WebSocket.** A bidirectional channel, which also needs its own
  reconnection, ordering and backpressure rules.

**Recommended.** B1 until a requirement exists. If one appears, B2 is the smaller
step: the events carry no state, only a hint, so the persisted state stays
authoritative exactly as the current design already requires.

**Blocked until answered.** Any real-time transport work; the notification and
message latency expectations that would justify it.

---

## U-06 — Write authority, RPO/RTO and an online provider cutover

**Class: B — product decision** · Tracked as roadmap items 9 and 14 (Phases 1 and
5) and [ADR 0010](../architecture/decisions/0010-sqlite-first-and-online-provider-cutover.md).

**The question.** Which engine is the write authority, and what recovery point and
recovery time are acceptable?

**Why it is open.** SQLite and PostgreSQL both exist and both are tested, and the
provider-migration journal can capture and replay changes. What does not exist is
the decision that says which engine owns writes during and after a cutover, and
therefore what RPO and RTO the product promises. The roadmap is explicit that a
configuration-only switch is not a live migration.

**Options.**

- **B1 — Stay on one engine.** Keep PostgreSQL as the single write authority and
  do not attempt an online cutover. The capture and replay machinery stays
  available for backup and restore.
- **B2 — Move to PostgreSQL.** Migrate the data once, offline, with a rehearsed
  rollback, and retire the SQLite production path.
- **B3 — Keep both, cut over online.** Complete the capture, replay, checkpoint,
  reconciliation and fencing work and migrate without downtime.

**Recommended.** B1 until the product has a real deployment. The capture and
replay machinery is already there and is tested; turning it into a live cutover
before a host is chosen is work whose value depends on a decision that has not
been made.

**Blocked until answered.** The online cutover implementation; a published RPO and
RTO; the cross-engine recovery design.

---

## U-07 — Accessibility beyond the three audited surfaces

**Class: A — the repository can close this** · Tracked as roadmap item 21 (Phase 4).

**The question.** Which surfaces does "accessible" cover, and how is that proved?

**Why it is open.** `e2e/accessibility.spec.ts` runs axe against the home page, an
article page and the writing desk, and checks the first keyboard stop and touch
targets. The rest of the product — the comment editor, messages, the account
pages, search, the tag and category pages, the archive, and the dialogs — is not
covered by that scan. Nothing decides whether those surfaces are in scope.

**Blocked until answered.** Nothing is blocked: this is a coverage gap. The
traceability row stays `partial` until the additional surfaces are scanned and
fixed, and until the definition of "no serious violation" is written down once
instead of being re-decided per page.

---

## U-08 — The editor works with a keyboard alone, and on a phone

**Class: A — the repository can close this** · Tracked as an unchecked item in
[Phase 0](../roadmap/phase-gates.md).

**The question.** Can an author write and format a work without a pointing
device, and can they do it on a narrow screen with a software keyboard open?

**Why it is open.** The article editor's IME and no-mouse formatting journeys are
covered by `e2e/authoring.spec.ts`, and the editor's touch targets are checked.
Keyboard-only operation of the formatting toolbar, the comment editor's parity
with the article editor, and the editor's behaviour when a software keyboard
resizes the viewport are not covered by any test.

**Blocked until answered.** Nothing is blocked: this is a coverage gap. The
traceability row stays `partial` until those journeys exist and pass.

---

## U-09 — Whether the site is installable and readable offline

**Class: B — product decision** · Tracked as roadmap item 21 (Phase 4).

**The question.** Does the product promise an installable application and an
offline reading experience?

**Why it is open.** There is no web manifest, no service worker and no offline
cache. A service worker adds a second, long-lived copy of public and private
content in the reader's browser, and it has to be reconciled with the private
response rules that already exist.

**Options.**

- **B1 — No PWA.** The site stays a set of documents. Nothing is cached beyond
  what the browser does by default.
- **B2 — Installable only.** A manifest and an install prompt, with no offline
  content.
- **B3 — Installable and offline-readable.** A service worker that caches the
  public reading surface and explicitly refuses to cache anything private.

**Recommended.** B3 if the product wants a reading experience that survives a
tunnel, and B1 otherwise. B2 is the option that costs the most and delivers the
least: it adds an install surface without the capability people install for.

**Blocked until answered.** Any manifest, service worker or offline cache work.

---

## U-10 — Future mobile and desktop clients

**Class: B — product decision** · Tracked as roadmap item 25 (Phase 5).

**The question.** Does the product commit to a React Native or Tauri client, and
if so, when?

**Why it is open.** The API and authentication contracts are the stated
precondition, and they are close to stable. The question is whether a second
client is wanted at all, and whether deferring it is acceptable.

**Options.**

- **B1 — Web only.** No second client. The public and authoring surfaces are the
  product.
- **B2 — A third-party client later**, built against the published REST contract
  and nothing more.
- **B3 — A first-party client now**, reusing the API contracts and the design
  system but not the Web application code.

**Recommended.** B1 or B2 for now. The REST contract is already documented and
published, so B2 remains available without a decision today.

**Blocked until answered.** Any first-party client work; any shared-UI extraction
that only a second client would justify.

---

## Maintenance

`scripts/feature-traceability.test.ts` keeps this file and the traceability map in
agreement. It fails when

- an entry's class is not one of `A`, `B` or `C`;
- an entry has no question, no recommendation or no blocked-until statement;
- the traceability map cites an id that does not exist here;
- an id defined here is cited by no capability row, so a decision cannot be
  recorded and then quietly forgotten.

Closing an entry means removing it here and turning the capability row back to
`verified` in the same change, with the tests that prove it.
