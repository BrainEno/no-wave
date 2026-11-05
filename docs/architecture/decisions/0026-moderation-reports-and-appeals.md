# ADR 0026: Reports, scoped moderation and independent appeals

- Status: **Proposed — not accepted, not implemented**
- Date: 2026-11-05
- Relates to: [issue #72](https://github.com/BrainEno/no-wave/issues/72),
  [ADR 0016](0016-editorial-taxonomy-and-editor-role.md),
  [ADR 0010](0010-sqlite-first-and-online-provider-cutover.md),
  [REST idempotency](../rest-idempotency.md), and the
  [proposed threat model](../moderation-threat-model.md)

This is a reviewable proposal, **not permission to implement a moderation schema, API or UI**.
Issue #72 requires an accepted ADR and threat model before implementation. The owner selected four
product directions on 2026-11-05, recorded in §1; the rest of this document is a recommendation or
an explicit open question. Selecting those directions did not accept this ADR, settle the legal
basis, approve deployment, or authorize a moderation release. No paths in §7 exist yet.

## Context: what must not be mistaken for a moderation system

People can publish articles, write threaded comments, edit profiles and exchange private messages,
but there is no reporting queue, moderation administrator, appeal or moderation audit. ADR 0016's
`member`/`editor` column and `EDITOR_USER_IDS` grant **editorial** control, not moderation. The
existing role endpoint lets an editor assign editorial roles; it must not accidentally become an
administrator grant. A person may eventually hold both capabilities, but neither implies the other.

The implementation has constraints that a design cannot wish away:

- A private message is readable only through conversation membership; conversation deletion can
  physically delete its messages. Reporting it cannot give an administrator general membership or
  access to the rest of the conversation.
- Authors' article deletion uses a recoverable tombstone; restoration returns a draft, and a
  bounded sweep can hard-delete expired tombstones (30 days by default). Comment deletion currently
  hard-deletes a comment and its descendants. Neither mechanism is a reversible moderator hide.
- Public Web pages currently permit a shared cache (`s-maxage=60, stale-while-revalidate=300`);
  media responses are publicly cacheable for one year and the same asset can be referenced elsewhere.
  Hiding a database row does not immediately recall cached HTML, media, screenshots or downloads.
- SQLite and PostgreSQL have different transactions, but both participate in provider-migration
  capture and replay. The existing journal can contain sensitive message rows and identity data.
  New evidence and its deletion cannot silently bypass the journal or become immortal in its copies.
- There is no MFA or account-disablement mechanism today. A privileged role is not by itself proof
  that the operator's account, support process or emergency recovery is secure.

## 1. Owner-selected directions and remaining gates

The owner chose these directions for this proposal:

1. **One reported private message.** Only a participant who can currently read that message may
   deliberately submit it; the administrator sees only that selected message, not its conversation.
2. **Administrators only for the first release.** A separately authorized administrator performs
   review and decisions; existing editors do not receive moderation access merely for being editors.
   A separate `moderator` role is a possible later extension, not a first-release role.
3. **After final closure:** retain report evidence for **90 days**, and a separately minimized audit
   record for **one year**. §6 distinguishes the two and defines the proposed clock.
4. **Independent appeals.** The original decision-maker and conflicted people cannot decide the
   appeal. If no independent reviewer is available, it stays pending; it is not automatically denied
   or accepted, and the existing action does not silently change.

The owner still needs to review the complete proposal and accept or amend the ADR and threat model.
In particular, the open items in §9 are **release and/or acceptance gates**, not defaults to silently
implement. Legal and privacy review must determine applicable obligations; the proposed durations
are product choices, not a claim of legal compliance.

## 2. Scope, authority and conflicts

The candidate first release reports an **article, comment, profile or one message**. A report is an
allegation, not proof, and no number of reports automatically hides content or suspends an account.
The candidate actions are **no action** and a reversible **visibility hold** on the specific target.
Warnings, account suspension, permanent deletion, proactive message scanning, automatic judgments,
attachments and general administrative access to conversations are out of scope. There is no promise
that this service is an emergency response channel.

Authority is checked on the server on **every** read and write, from the verified current actor, not
from a request's `userId`, a profile role, a browser marker, or a cached JWT role claim. Role revocation
must take effect for subsequent requests without waiting for an access token to expire. Unknown roles,
unavailable authorization/audit storage, and missing privileges fail closed. Access to a case does not
confer access to unrelated cases, draft works, the message's thread, or another reporter's data.

A future administrator capability must be stored and granted independently of `user_profiles.role`.
It must not be obtained via `EDITOR_USER_IDS` or the existing editor role endpoint. Existing accounts
are not silently promoted, and editor behavior stays compatible. Initial administrators, subsequent
grants/revocations, last-admin recovery, two-person operation and break-glass access require a
separately reviewed, auditable operational procedure (§9); never solve bootstrap by letting any
editor grant themselves administrator. Do not ship until there are at least **two distinct eligible
human administrators**, and a process for obtaining an independent substitute when both are
conflicted or unavailable. Two accounts controlled by one person are not independent reviewers.

A reviewer cannot inspect evidence or act on a case in which they are the reporter, the subject, an
owner/sender of the target, or a participant in the reported conversation; nor may they adjudicate a
case with another declared conflict, including a close personal or organizational relationship.
For an appeal, the person who made the original decision is also disqualified. Conflicts apply to
all merged reports and actions in the case, not just the last report. Administrators must declare
additional conflicts, and eligible reviewers must be reassigned; technical checks cannot detect all
relationships. Queue, lookup and error responses must not disclose a conflicted or unauthorized case
or its evidence. If no reviewer is eligible, escalate operationally, retain the current state and
never invent an exception to independence.

**Deletion makes the conversation conflict check nontrivial.** Current `conversation_participants`
rows include departed members but are deleted with the conversation. Checking only current
participants, or treating a missing conversation as "no conflict", would allow a former participant
to become a reviewer. Eligibility must be checked again when the administrator opens evidence,
decides or resolves an appeal, including people appointed after submission. If the necessary conflict
facts are unavailable, fail closed and escalate; do not infer permission.

One option for P10 is a case-scoped, keyed pseudonymous conflict guard for current and former
participants, maintained transactionally when membership changes and before conversation deletion.
It would let the server check a later administrator without displaying a roster or any other message
to reviewers. Such tokens are still sensitive membership data, need their own narrowly scoped key,
access and evidence-retention/deletion controls, and can leak information if misused. They would be
private report data subject to the 90-day post-closure deadline, not one-year audit; no reviewer API
may expose an arbitrary membership-check oracle. A conversation's historical participant set can
grow, so any size bound or key/guard failure must make verification unavailable rather than silently
truncate it. Preserve the ordinary ability to delete a conversation: where possible, atomically mark
affected cases unreviewable when a complete guard cannot be preserved, rather than retain private
messages merely to serve reviewers. This is only an option for privacy and operational review, not
authority to collect extra data. An alternative is to keep affected cases unreviewable after deletion
when independence cannot be verified. The owner and
privacy reviewers must choose a feasible approach and its retention/availability tradeoff (P10), in
coordination with the unresolved open-case policy (P3).

## 3. Reporting, evidence and abuse resistance

### Reportable target and consent

A report records the verified reporter, one target type and stable server-resolved target ID, a
versioned reason code, an optional bounded note and timestamps. The server, not the client, resolves
the subject and captures the evidence. Proposed reason codes are `harassment`, `threat`,
`hate_or_discrimination`, `sexual_exploitation`, `privacy_or_doxxing`, `spam_or_scam`, and `other`;
wording, categorization and an incident escalation policy still need owner/legal review. A report's
note is private and treated as evidence, not a field to copy into a notification or audit log.

| Target | Candidate evidence and visibility rule |
| --- | --- |
| Article | The reported, currently public version in the selected locale, including the minimum text needed to review it. Do not fetch other locales or private drafts as a side effect. A visibility decision, if made, affects the whole article across locales. |
| Comment | The selected visible comment and its stable identity, not its descendants or unrelated thread content. |
| Profile | The selected currently visible profile fields and locale; no private account information. |
| Message | **Only one** selected message's server-stored text and minimum sender/target metadata. The reporter must be a currently authorized participant at the instant of submission, expressly confirm the specific text will be shared with administrators, and receive a preview. No adjacent messages, membership roster displayed to the reviewer, background scanning, attachments or automatic conversation export. |

All reportable targets must be visible to that reporter at submission. A missing, deleted, hidden or
unauthorized target has the same non-enumerating answer; the server never accepts a fabricated
client-supplied evidence snapshot as the message. The preview and commit are tied to a trustworthy
server version: if it changed, ask the person to review the new preview rather than silently submit a
different text. The current schema does not supply this proposed version contract for every target;
it would have to be designed, migrated and tested on both providers. For a message, membership,
message existence, evidence capture and deletion/removal races must be serialized in the same
transaction. Once successfully submitted, the minimal evidence copy can remain after the source is
deleted, within §6's limits; a failed submission leaves no copy. The consent screen and privacy
notice must say this plainly.

A reviewer may see the selected evidence only through an authorized, conflict-checked case view.
Opening it creates a minimal access audit; inability to audit means no evidence response. The platform
knows the reporter's identity, but the default review view does not display it: the server checks
conflicts without exposing the identity. Any exceptional disclosure needs a separately authorized,
audited and legally reviewed purpose. The API must not automatically render active content, fetch
embedded links or images, or use reporter-supplied URLs as server fetch targets. Notes and content
are bounded and treated as untrusted text. If a current public target changed after the snapshot,
the reviewer sees a stale indication and must review the current **public** version before a new
visibility decision; never fetch a later private draft or an unreported message. If a target became
private or was tombstoned after the report, whether a hold based on the earlier public snapshot may
constrain a later restore/republish is unresolved (P7); it must not be represented as a review of the
current private version. If the target no longer exists, a case can be decided from the remaining
evidence, but no operation recreates it.

### Duplicates, queue and throttling

Proposed behavior: an exact retry of one reporter's intent returns that reporter's receipt; a
second active report from the same reporter for the same target version and materially equivalent
reason/evidence is deduplicated without revealing other reports. Material new information or a new
target version must not be silently discarded; a bounded additional submission can be considered
with its own intent and
evidence. Different reporters may attach separate reports to a single **undecided** target case, but
their identities, notes and evidence stay separate and never appear in another reporter's receipt.
A report after a decision creates a new case; it does not silently extend the old case or its
retention clock. A merge must update conflict checks across **all** associated reports. A reviewer
can split cases if targets or evidence are not in fact equivalent, with a recorded reason and no
disclosure between reporters; a split must never evade a genuine conflict. These are proposed product
rules, subject to §9.

Queue order should be based on an approved reason/severity rubric and age; reporter-selected urgency
and report volume alone cannot determine severity or automatic punishment. There is no promised SLA
until the operator has capacity to meet it. Use durable, fail-closed per-verified-user and peer-IP
rate limits, consistent with [ADR 0011](0011-persistent-api-write-rate-limits.md); exact quotas and
abuse escalation remain to be approved. Do not trust client forwarding headers. Apply size and page
limits, and avoid a single shared-IP limit that silently prevents all users behind a proxy from
reporting without an operational mitigation. A false report is not itself proof of malicious intent;
no automatic account sanction follows a dismissed report.

## 4. Case, decision, hold and appeal state

A **report** is a person's submission. A **case** groups related reports about one target. A
**decision** is a reviewer's recorded outcome; a **hold** is a separate reversible visibility
constraint owned by that decision. An **appeal** challenges a decision; it is not an edit to the
original report. All state transitions, authorization, version checks, audit records, notification
intent and migration capture commit atomically on the authoritative provider. A retry cannot create
a second hold, audit decision or notice.

Candidate case transitions:

| From | Event / required actor | To | Consequence |
| --- | --- | --- | --- |
| none | authenticated, authorized submission | `open` | private receipt and evidence; no visibility change |
| `open` | eligible administrator starts review | `in_review` | assignment/claim, not evidence of a violation |
| `in_review` | eligible administrator records `no_action` or `hide` | `decided` | decision, optional hold, audit and notices in one transaction |
| `decided` | eligible subject submits an in-window appeal of a `hide` | `decided` | appeal becomes `pending`; the hold remains |
| `decided` | no-action decision and reporter notice are durable; or an appeal resolves; or an actionable decision's appeal window expires without appeal | `final` | set one final-closure timestamp; start §6 retention clocks |

A `no_action` decision has no hide for the subject to appeal and, under the candidate first-release
rule, becomes final after its decision and reporter notice are durable. Whether a reporter may
appeal a dismissal is an open product question (§9). For an actionable decision, an appeal remains
`pending` until an independent eligible administrator claims it, then is `in_review`. The only
candidate outcomes are `upheld` (hold remains) or `reversed` (release **that decision's** hold).
Record the reason code and notify the affected subject; never overwrite the original decision. A new
allegation or different action needs a new decision with its own notice and appeal opportunity.
Reject invalid or stale transitions with a stable conflict; if the target version, eligibility,
assignment, appeal status or active holds changed concurrently, re-read and re-authorize before any
new decision. When the appeal is pending, no timeout may silently decide it. The policy for cases
that remain open too long is an explicit gate in §9, not indefinite evidence retention.

The candidate appeal window is **30 days from durable in-app decision notice**, not from an
unobserved best-effort email or a moderator's click. The duration, deadline behavior, whether
reporters can appeal and exceptions require explicit approval. A late submission must not silently
reopen a finalized case or extend retention; any exception must be a documented, authorized process
with a new retention decision. A genuinely unavailable independent reviewer creates an operational
alert; it does not give the original decision-maker authority to review their own work.

### Visibility holds and restoration

Visibility is the intersection of the target's ordinary visibility and **all** active holds. Releasing
one hold cannot override another case, an author's deletion/unpublishing, membership rules, or any
other independent restriction. A hold is anchored to a stable target ID, not a reusable slug; author
edit, delete and restore must not erase it. Decisions are tied to the version actually reviewed, so a
stale decision cannot silently suppress new content without review. How long an upheld hold can last,
how it is reassessed and how it ends need a separate explicit policy (P9). A hold's minimal current
visibility state must not become an indefinite substitute for the report evidence or audit record;
the 90-day and one-year deadlines still apply. In particular, a pending appeal does not silently
change the action just because no independent reviewer is available.

| Target | Candidate reversible effect | On release / independent deletion |
| --- | --- | --- |
| Article | Exclude the entire work, all locales and every public list/detail/search/related/SEO surface. The author may view/edit privately but cannot republish around an active hold. | When the last hold clears, leave an extant work as a **draft**; the author explicitly chooses to republish. Author tombstone/delete/restore never removes a hold. An already purged work is not recreated. |
| Comment | Hide only that comment's body, with a neutral placeholder where necessary to preserve its descendants and thread shape; do not cascade-delete them. | Reveal only if the underlying comment still exists and no other restriction applies. Existing owner deletion can physically delete the subtree; a reversal never recreates deleted comments. |
| Profile | Mask the offending fields across public and authenticated profile projections, including directory and identity search; use neutral labels where needed while retaining account identity and ordinary conversation authorization. Edits alone do not lift the hold. | Reveal only the current profile subject to all other restrictions; do not expose previously private fields. |
| Message | Hide only the selected message body from subsequent conversation reads, using a neutral placeholder for otherwise authorized participants. Do not expose or hide other messages. | Restore only to people who can currently read that conversation and only if the source message still exists; deleted conversations/messages are not recreated. |

This is not a media takedown guarantee. Page cache invalidation and the publicly cacheable media
problem require a separately reviewed delivery plan before rollout. The operator must know the
actual propagation window, be able to invalidate or disable relevant shared HTML caches, and have an
incident process for harmful media that may remain at a direct URL or in a third party's cache. A
successful database commit alone must not be described as immediate worldwide removal. Reporting an
article does not automatically delete a shared asset used by another work.

## 5. Notices, privacy and accessibility

The candidate first release persists an in-app receipt for the reporter and, for a visibility action,
a notice for the affected author/profile owner/message sender. It includes the affected item,
reason category, action, appeal mechanism and deadline, but **not the reporter's identity, their
note, other reports, or unrelated private messages**. The reporter gets a generic status/outcome,
not identities of reviewers or details of another person's appeal. A sender may infer who reported a
message from the context, especially in a two-person conversation: do not promise anonymity that the
system cannot guarantee.

Notification intent is durable and idempotent with the decision; asynchronous delivery may retry.
A failed notification must be visible to operators and must not silently start the appeal window as
if an in-app notice existed. Do not add evidence text, message bodies or reporter identity to
notifications, logs, analytics, metrics labels or outbox payloads. Ordinary request logs and metrics
use canonical route templates rather than report/case IDs; the separate restricted audit may retain
only approved identifiers. Email/push are not part of this proposal. All report, case, evidence,
decision and appeal responses and pages are `no-store`, even when the underlying article was public. Browser mutations use the existing BFF origin/CSRF and
session rules; a UI control is never an authorization boundary.

Reporting and appeal UI needs accessible labels, keyboard use, clear confirmation of the one-message
share, localized reason text, pending/error/retry states, and a way to preserve the same request on
an uncertain result. It must explain the reporting process, independent appeals, retention,
limitations of cache/media removal, and where to seek immediate assistance. Exact copy is a later
review artifact, not shipped here.

## 6. Retention, redaction and deletion responsibilities

**Clock.** For an actionable decision, `final_closed_at` is set once after an appeal is resolved, or
after the approved appeal window expires without an appeal. For a no-action case, the candidate rule
is the durable decision and reporter notice. No clock starts merely because a decision was made
while a timely appeal is pending. A later new case has its own clock and cannot mutate an old one.
For this proposal, a day is 24 hours and one year is 365 days, measured from that timestamp in UTC;
legal review may require a different calendar rule. Boundary and concurrent-sweep behavior need tests.

| Class | Contents / candidate boundary | Deadline after final closure |
| --- | --- | --- |
| Report evidence and private report data | selected snapshot including the one message, free-text notes, reporter identity/linkage, and other sensitive report details | remove by **90 days** |
| Minimal audit | case/decision ID, authorized acting administrator, action/outcome, timestamps and only the target reference/reason code proven necessary for accountability; no message text, report notes or reporter identity | remove by **one year** |

These are **different records and deadlines**; a year-long audit record must not become a covert
copy of 90-day evidence. Target IDs, actor IDs and reason codes can themselves be personal or
sensitive data: access remains restricted, fields need privacy review, and the minimum is not a
claim of anonymity. Persist the deletion deadlines with the finalization transaction, make sweeping
bounded and retryable, and alert on missed deadlines. Expiration applies to accessible copies of the
**report evidence**, including evidence captured in journals, replicas, exports and backups, not just
the primary row. Before launch, the operator must demonstrate that all copies are removed by the
chosen deadline, or return to the owner for a different explicit policy; silently extending backups
is not acceptable. Restores must replay deletions/expiry before serving traffic, so an old backup
cannot resurrect evidence or a released hold. Do not log deleted text to prove deletion.

A recorded legal hold is a possible exception **only** after legal review: narrowly scoped,
authorized, documented with an owner and review/expiry date, periodically reassessed, and removed
as soon as no longer required. It is not an indefinite "just in case" flag. The open-case/appeal
maximum, deadlines and handling at that maximum remain unresolved (§9). No real reports should be
collected until an enforceable policy exists for them as well as finalized cases.

The 90-day rule covers the submitted evidence copy, not the original message still legitimately
visible to its participants, unrelated source snapshots, or copies a participant has made. Existing
message data and provider-journal retention have their own unresolved privacy obligations. Operators
must explain these distinctions rather than claim universal erasure. Backup, journal and source-data
policies need coordinated review, particularly where the same bytes exist in both roles.

The preferred security direction is encrypted evidence with authenticated encryption and separately
controlled keys, plus strict case-level authorization and redaction; the actual key management,
rotation, backup and deletion scheme is **not designed or implemented**. A wrapped key copied into
an append-only journal or backup can defeat supposed crypto-erasure: do not rely on it unless all
recoverable key copies are accounted for. Audit trails must allow policy-driven deletion; "append
only" must not mean "kept forever". Storage operators with database or key access remain a threat,
not an invisible trust boundary.

## 7. Candidate REST contract (design only)

These are proposed shapes for review, **not live endpoints**. Names, error codes and examples can
change before acceptance. All routes derive the actor from the authenticated server context; private
responses are `Cache-Control: no-store` and unauthorized/nonexistent resources are indistinguishable
where a difference would disclose a case or message.

| Candidate operation | Authorized caller | Candidate behavior |
| --- | --- | --- |
| `POST /api/v1/reports` | signed-in reporter who can currently view target | Body names target type/ID, selected locale when relevant, reason and optional note; message reports require explicit one-message share confirmation. Required `Idempotency-Key`; return only the reporter's receipt. |
| `GET /api/v1/me/reports/:id` | original reporter | Own generic status, no other reporter, reviewer or appeal data. |
| `GET /api/v1/me/moderation-decisions/:id` | affected subject | Own action, reason category and appeal instructions; no reporter identity or note. |
| `POST /api/v1/me/moderation-decisions/:id/appeals` | affected subject within approved window | Required `Idempotency-Key`; private receipt. Recheck subject, deadline and decision under lock. |
| `GET /api/v1/admin/moderation/cases` and `.../cases/:id` | eligible administrator | Bounded queue and case metadata; exclude conflicted cases. Metadata is not permission to browse conversations or private drafts. |
| `GET /api/v1/admin/moderation/cases/:id/evidence` | eligible, conflict-checked administrator | Only the submitted case evidence; record access before returning, otherwise fail closed. No arbitrary conversation lookup. |
| `POST /api/v1/admin/moderation/cases/:id/decisions` | eligible administrator | Required idempotency key, reviewed version and expected case state; atomically commit decision, hold if any, audit and notice intent. |
| `POST /api/v1/admin/moderation/appeals/:id/resolutions` | independent eligible administrator | Required idempotency key and expected state; `upheld` or `reversed`, with audit and notice intent. |

Candidate errors: `401` for missing/invalid authentication; generic `404` for a missing or
non-disclosable resource; `409` for an outdated target/state or a reused idempotency key with a
different request; `429` with `Retry-After` for a rate-limited write; a temporary failure if required
authorization, audit or durable storage is unavailable. Exact public error names are a contract review
item. A report/appeal/decision retry reuses the same actor-scoped key and normalized intent; changed
intent conflicts rather than overwriting history. Recheck current authorization on replay and never
store raw idempotency keys or sensitive response bodies. Low-entropy notes and reason codes make
unkeyed request hashes vulnerable to guessing; review a domain-separated keyed fingerprint and its
key rotation/deletion scheme for these sensitive writes, and update the generic idempotency contract
if accepted. Explain the bounded replay lifetime once retention purges the underlying record; do
not promise an old key works forever. Extend the existing idempotency inventory only when an actual
contract is accepted and implemented.

## 8. Future implementation and verification gates

No migrations are included in this ADR. Once accepted, a small implementation proposal must include:

1. **Both providers and compatibility.** Equivalent SQLite/PostgreSQL schema constraints,
   transactions, backfill and indexes; additive administrator capability; no implicit editor grant;
   old profiles and clients remain valid. Decide rollout order and prevent old readers/writers from
   bypassing holds. Take a backup, test migration and rollback with disposable data, and document
   that rolling back schema or application code cannot silently re-expose held content.
2. **Capture, replay and copies.** Extend the provider journal/replayer allowlist and same-transaction
   capture for reports, decisions, holds, appeals, audit, expiry and their deletes. Account for
   sensitive ciphertext, keys, backup expiry, cascading deletes, idempotent replay, reconciliation,
   source fencing and rollback. If exhaustive coverage cannot be proven, disable provider cutover
   while this feature is active; no synchronous dual writes. Never claim online cutover is already
   available.
3. **Enforcement across surfaces.** Enumerate every public and participant read, search, index, SEO,
   related work, cache, author restore/edit, comment tree, profile and message route; apply the same
   visibility predicate. Define and rehearse cache invalidation and media-incident limits.
4. **Test first.** Given/When/Then coverage on both real providers for authorization and conflicts,
   active message membership and delete races, duplicate submissions and exact replay, stale versions,
   two administrators racing, overlapping holds, owner delete/restore/purge, independent appeal and
   missing reviewer, notice retries, 90/365-day boundaries, legal holds, backup restore and journal
   replay. Contract tests must verify no cross-case, reporter or message disclosure and no private
   caching; browser tests cover consent, localized accessible reporting, failure and appeal journeys.
5. **Operations.** Approve role bootstrap, reviewer availability, response capacity, incident/media
   escalation, key custody, deletion/restore runbooks, monitoring and privacy notices before enabling
   real submissions. Two administrator accounts are necessary but are not MFA; establish an
   independently reviewed account-security control before giving them private evidence access.

The [threat model](../moderation-threat-model.md) maps concrete threats to these proposed controls and
tests. Passing this design review alone will not satisfy #72's implementation acceptance criteria.

## 9. Explicit decisions still required

| ID | Decision and proposed direction | Why it gates acceptance / release |
| --- | --- | --- |
| P1 | Approve reason taxonomy, reviewer rubric, priority and incident/escalation procedures; define capacity and quotas. | A report count is not a verdict; legal/emergency expectations and abuse handling must be explicit. |
| P2 | Decide appeal window (candidate 30 days), late exceptions and whether reporters can appeal dismissals. | Determines final closure, notices, fairness and retention clocks. |
| P3 | Set a **maximum retention and operational outcome for unresolved reports and pending appeals**, including lack of an independent reviewer; define narrowly scoped legal holds. | The selected 90/365-day clocks start only after final closure and cannot justify indefinite open-case storage. Preserve independent review without silently deciding an appeal. |
| P4 | Design administrator bootstrap, grant/revocation, independent-human verification, conflict declarations, account security and emergency recovery. | No moderation/admin role or MFA exists; `editor` bootstrap is not sufficient. |
| P5 | Approve evidence encryption/key lifecycle, backup and journal deletion/recovery, source-data policy and data-subject notices. | The selected retention deadlines must hold across recoverable copies, not merely the live row. |
| P6 | Decide HTML cache propagation objective, purge/failure handling and a separate shared-media incident process. | Current cached pages/media can outlive a database hide and shared assets affect other authors. |
| P7 | Confirm target-specific hold/restore behavior, including an unpublish/tombstone before decision; reporter duplicate/merge rules; and whether a subject can view selected evidence for an effective appeal without revealing another participant. | Hiding a whole translated work, constraining a private edit, deleting a thread and revealing private content have different consequences. |
| P8 | Determine legal/privacy basis, jurisdictional obligations, data access/deletion requests and exceptions. | This proposal is not legal advice and does not establish compliance. |
| P9 | Decide the maximum duration, reassessment and ending of an upheld visibility hold, including pending appeals and continued holds after audit expiry. | A permanent visibility flag could become an unreviewed sanction or covert audit retention. Do not silently change a pending appeal's action or extend the selected evidence/audit deadlines. |
| P10 | Choose how to verify reviewer independence for a message after conversation membership is deleted; review the case-scoped pseudonymous-guard option against fail-closed unavailability, data minimization, key custody and retention. | The source roster cascades away today. A missing row is not proof of no conflict, but retaining a guard creates additional sensitive data. |

**Decision request:** reviewers should resolve or explicitly gate P1–P10, review the linked threat
model, then explicitly accept or reject this ADR. Until then, keep #72 open and do not implement its
moderation migrations, services, REST routes or audit system.
