# Threat model: proposed reports, moderation and appeals

- Status: **Proposed — controls and tests below do not exist yet**
- Date: 2026-11-05
- Scope: the candidate first release in [ADR 0026](decisions/0026-moderation-reports-and-appeals.md),
  including one-message reports, administrator-only review, holds, independent appeals, retention,
  provider migration and caches.
- Issue: [#72](https://github.com/BrainEno/no-wave/issues/72)

This document assesses a proposal, not deployed security controls or legal compliance. Issue #72
requires the ADR and this threat model to be accepted before its database/API implementation. The
owner's selected directions are recorded in the ADR; approval of those directions is not acceptance
of either document. The unresolved decisions and release gates in ADR 0026 §9 are part of the threat
model, not optional follow-up work.

## Assets and trust boundaries

**Assets:** the selected message and other evidence, reporter and subject identities, case and
appeal existence, restricted reviewer notes, authorization grants, decision/hold integrity,
notification state, original content and conversations, migration journals, backups and key material.
Even a target ID, reason code or timestamp can be sensitive. Availability and timely independent
review also matter: a stuck hold can silence lawful content and a stuck report can leave harmful
content visible.

**Actors:** anonymous visitors; signed-in reporters and subjects, including abusive or compromised
accounts; legitimate and malicious administrators; a person controlling multiple accounts; database,
backup, log and key operators; Web/API processes and workers; caches and object storage; and third
parties who have already copied public content. An administrator is not trusted with all private
messages merely because they can review a report. A database or infrastructure operator may bypass
application controls; evidence encryption and controlled key custody must be designed for that
boundary rather than described as an existing protection.

**Candidate data flow:**

1. An authenticated reporter sees a target through an existing authorized read. For a message,
   they explicitly preview and submit **one** message, not the conversation. The browser, any IDs and
   notes are untrusted. The BFF enforces the existing origin/session contract; the API verifies the
   actor and current access itself.
2. Within the authoritative SQLite or PostgreSQL transaction, the service checks membership and
   target version, creates the private report/evidence and receipt, and records any journal change.
   A concurrent deletion or membership removal must have a deterministic serialization order. The
   report can later outlive the source message only within the approved evidence-retention policy.
3. An eligible administrator accesses only the case-scoped evidence after authorization, conflict
   checks and an audit write. A decision commits with its hold, audit and notification intent; an
   independent eligible administrator may later resolve a timely appeal. The proposed `no-store`
   boundary includes errors and the BFF, not just the API's successful response.
4. Public/participant reads consult ordinary authorization **and** active holds. Shared Web caches,
   direct media URLs and already downloaded bytes are separate delivery boundaries; a database
   update cannot recall copies. Private decisions and evidence never enter those shared caches.
5. Final closure starts the selected 90-day evidence and one-year minimal-audit clocks. A future
   bounded sweep and an independently reviewed backup/journal/key procedure must prevent resurrection
   on restore or provider replay. The maximum for open cases and pending appeals remains undecided.

## Threats, proposed controls and residual risk

Test IDs refer to the **future** verification plan below; none is a claim that a control already
passes. Severity is qualitative and assumes real users and private messages.

| ID / severity | Threat and attack | Proposed control / verification | Residual or decision needed |
| --- | --- | --- | --- |
| T01 / critical | IDOR or actor spoofing: submit another participant's message, read another person's report, or send an administrator/subject ID in a body. | Verified server identity; participant/owner/role and case-scoped checks on each operation and replay; generic nondisclosing 404 for unavailable targets; A1, A2, A14. | An authorized user can still submit words they are entitled to see; account compromise remains possible. |
| T02 / critical | A participant is removed or a conversation is deleted between access check and snapshot, creating a report from content they can no longer access or leaving a partial copy. | Serialize membership, source existence, capture and receipt in one provider transaction; define which concurrent commit wins; A2, A7. | Source deletion after a successful submission does not erase the allowed evidence copy before its deadline. |
| T03 / critical | An administrator uses a message report as an excuse to read adjacent messages, the participant roster, private drafts or unrelated cases. | Only the submitted one-message snapshot and minimal metadata; no privileged membership or conversation browse; scoped evidence reads, conflict checks and audited access; A1, A2, A6. | An administrator may already be an ordinary participant in a different conversation; unrelated normal rights are not expanded by a case. Infrastructure operators still need separate controls. |
| T04 / high | Reporter or subject identity leaks through receipts, notification payloads, queues, errors, counts, logs or shared caches, enabling retaliation. | Separate reporter/subject/administrator views, non-enumerating answers, no reporter identity or free text in subject notices, no-store, redacted telemetry; A1, A8, A11. | The sender of a two-person message may infer the reporter. Do not advertise absolute anonymity; review what information an effective appeal needs (ADR P7). |
| T05 / critical | A malicious or compromised privileged user promotes themselves, obtains a role via the editorial endpoint, or keeps access after revocation. | Independent administrator capability, no `EDITOR_USER_IDS` inheritance, audited grant/revoke and offline bootstrap, server-side current authorization, strong operational account-security gate; A6, A14, A15. | Existing identity does not provide MFA. Bootstrap is decided — an `ADMIN_USER_IDS` allowlist checked per request (2026-11-07) — but account security, last-admin recovery and independent-human verification remain open gates (P4). |
| T06 / high | An interested administrator or original decision-maker dismisses evidence or rubber-stamps their own appeal; two accounts represent the same human. After conversation deletion, treating a missing roster as no conflict lets a former participant review. | Server-enforced subject/reporter/conversation/decision-maker exclusions, fail closed if conflict facts are unavailable, declared conflicts, independent human review and audit; A2, A5, A6, A15. | Personal relationships are not fully machine-detectable. A possible case-scoped keyed guard itself retains sensitive membership information; its feasibility and deletion need review (P10). Two people do not guarantee an unconflicted reviewer. |
| T07 / high | Coordinated false/duplicate reports, targeted report flooding or joining a case as a reporter makes every reviewer conflicted and suppresses speech or starves the queue. | No automatic sanction based on count; authenticated/IP throttles, bounded notes, separate reporter evidence and receipts, careful case split/reassignment with audit, operational monitoring; A6, A7, A12. | Quotas, queue rubric, staffing and treatment of material new information require approval (P1/P7). A split cannot be used to evade a genuine conflict. |
| T08 / high | A reviewer acts on stale content; an author edits, deletes/restores or swaps a slug to bypass a hold, or one case's reversal releases a second case's hold. | Server version token, stale re-review of public data, stable target IDs, intersect all active holds with ordinary visibility, atomic release and no automatic recreation of deleted source; A3, A4, A5. | Article holds affect all locales; media and deleted-comment subtree implications need an explicit product decision (P7). |
| T09 / high | Duplicate requests, response loss, two workers or forged replay create multiple decisions, inconsistent holds or duplicate notices. | Actor-scoped idempotency keys and request fingerprints, expected-state/version checks, transactionally coupled decision, audit, journal and notice intent; re-authorize replay; A5, A7, A8, A10. | Replay is bounded by retained records; a key cannot promise permanent deduplication after deletion. |
| T10 / high | A notice is lost while an appeal deadline silently starts, or the original reviewer decides because no independent reviewer is available. | Durable in-app notice before the candidate deadline starts; pending appeal retains its current action and raises an operational alert; independent adjudication only; A5, A8. | Appeal duration, late exceptions, reporter appeals and a maximum for unresolved cases are open (P2/P3). No available reviewer is not consent to violate retention. |
| T11 / critical | Sensitive evidence is logged, placed in an outbox, stored in an append-only journal, retained in a backup or restored after its 90-day deadline. | Minimize and encrypt evidence; exclude text/notes from telemetry and event payloads; prove deletion of recoverable copies and replay expiry on restore; restricted audit expires separately; A8–A10. | Key custody, encryption and selective backup/journal expiry are not implemented (P5). Original message copies have separate retention; no universal-erasure claim. |
| T12 / high | A legal-hold flag or unresolved case becomes indefinite storage; a fabricated audit trail launders evidence for a year. | Narrow, authorized, reviewed hold with owner and expiry; approve an open-case maximum and outcome; separate evidence from minimal audit, delete each on time, alert on failure; A9, A15. | Applicable law and a fair, feasible outcome at an unresolved-case deadline need review (P3/P8). |
| T13 / high | Database hide succeeds while shared stale HTML or direct immutable media still serves harmful content. A shared image is deleted and harms unrelated authors. | Inventory all delivery surfaces; invalidate or disable shared HTML cache, monitor propagation; separate shared-media incident process; never auto-delete shared assets; A11. | Current HTML uses `s-maxage=60, stale-while-revalidate=300`; media uses a one-year immutable public cache. Third-party downloads/caches cannot be recalled. Objective and incident process are open (P6). |
| T14 / critical | Old application versions bypass holds, provider migration misses a new entity/delete, or rollback/backup restore resurrects hidden content or expired evidence. | Additive compatible rollout with a mixed-version fence; both-provider migrations, transactional capture, allowlisted replay, delete tombstones, reconciliation and tested restore; disable cutover if coverage is incomplete; A4, A9, A10. | Online cross-provider cutover is not currently implemented; rollback after target-only writes needs a separately reviewed recovery plan. |
| T15 / high | A report note, article or message contains HTML/script, a hostile URL or huge input that causes XSS, SSRF, unauthorized content loads or resource exhaustion in the review console. | Bounded input and pagination, safe text rendering, no automatic external URL/image fetch, no raw content in logs, authorization and rate limits; A11–A13. | Reviewers can still choose to navigate to a hostile link unless UI and operational training address it. |
| T16 / high | Rate limits or a database/key/audit outage prevent reporting or make private review fail open; reviewers cannot distinguish outage from an empty queue. | Fail closed for evidence/action when authorization or audit fails; actionable operational alerts; stable unavailable/429 responses and `Retry-After`; account for shared proxy IPs; A1, A8, A12. | Fail-closed protects confidentiality but can delay help. Initial capacity, thresholds and alternate incident process require operational review (P1). |
| T17 / high | An upheld hold becomes an indefinite sanction or a hidden copy of the decision after the one-year audit deadline; an expiry timer silently changes a pending appeal's action. | Approve a bounded hold/reassessment policy separate from evidence and audit expiry; minimize state and require explicit, notified transitions; A5, A9, A15. | Hold duration and the interaction with pending appeals and expired audit are unresolved (P9). Do not extend the selected retention deadlines by calling an audit record a hold. |

## Future verification plan

These are acceptance tests for a **later implementation**, not tests run for this document. Use
synthetic data only. Run the same persistence behavior on real SQLite and PostgreSQL, and use
controlled transaction barriers rather than sleeps for races.

| ID | Required test or operational evidence |
| --- | --- |
| A1 | Member, reporter, subject, editor, administrator and anonymous caller exercise every read/write, guessed IDs and body identity spoofing; cross-case/conflicted/unauthorized lookups do not leak existence or content. Authorization and audit outages fail closed. |
| A2 | A real active participant reports exactly one message. Race submission against removal and conversation deletion in both commit orders; assert either a fully authorized snapshot/receipt or none. No adjacent message, exposed roster, forged text or side-effect survives a failed submission. After source deletion, test current/former participants, newly appointed administrators and membership changes since submission; unknown conflict status fails closed. Exercise the chosen guard, its size/key failure, ordinary conversation deletion and its own expiry once P10 is decided. |
| A3 | Change an article/profile version between preview, submission and decision; stale intent conflicts. A hold covers every locale, search/list/SEO/related path and relevant cache, while drafts and unreported messages remain private. |
| A4 | Race hold with author unpublish/delete/restore and tombstone sweep; IDs and all holds survive as appropriate, no removed target is recreated. Hide a comment without deleting descendants; owner deletion's existing cascade is not falsely presented as reversible. |
| A5 | Two reviewers race decisions, appeals and releases; only legal transitions and one effect commit. Multiple holds compose; a reversal clears only its own hold. Original reviewer, subject, reporter and declared conflicts cannot decide the appeal; absence of an independent human leaves it pending. |
| A6 | Old `member`/`editor` data and `EDITOR_USER_IDS` confer no moderation grant. Check every role-grant/revoke/bootstrap path, conflict after case merge/split, reassignments and attempts to use two accounts of one person as independent review. |
| A7 | Concurrent exact retries and lost responses for report/appeal/decision create one result; a changed payload conflicts. Fail a transaction after evidence/audit/notice/journal writes and verify rollback. Recheck permissions on replay and test behavior after idempotency retention expires. |
| A8 | Notices and evidence-access audit survive retries without exposing evidence or reporter in outbox, inbox, logs, metrics or errors. A failed durable notice does not start the candidate appeal deadline; private successes **and errors** are no-store. |
| A9 | Test exact 90-day/365-day boundaries from final closure, pending-appeal and visibility-hold behavior once P2/P3/P9 are decided, authorized legal holds and retryable failed purges. Restore a real disposable backup after expiry; expired evidence and released holds do not reappear. Verify key copies and expiry in all journals/replicas/backups, not only live rows. |
| A10 | Migrate both providers from prior schemas; verify equivalent constraints and failure behavior. Capture/replay every new entity and deletion exactly once, including cascading source deletion and expiry, then reconcile. Test rollback/fencing, replay errors and restoring under old versions without bypassing holds. |
| A11 | Exercise direct API, Web SSR, cache and SEO paths for visibility and private no-store. Test real configured HTML cache invalidation/failure and the published media limitation; do not claim removal of externally copied bytes. |
| A12 | Rate-limit duplicate and targeted report floods across actors and peer IPs, including a shared proxy; validate pagination/size bounds and non-enumerating errors. Prove queue overload and reviewer shortage alert without automatic sanctions. |
| A13 | Render malicious markup, long text, encoded identifiers and external URLs as inert content; no script execution, automatic fetch, SSRF or unbounded response. Verify message-share preview, explicit consent, keyboard access, localized labels and safe retry UX. |
| A14 | Revoke an administrator while an old signed token and in-flight case view exist; subsequent operations and replay lose access. Ensure roles cannot be injected through cookies, browser markers or request data. |
| A15 | Review and rehearse bootstrap, human independence/conflict declarations, secure reviewer accounts, emergency recovery, incident routing, legal-hold approvals, retention monitoring and key/backup custody. Synthetic test accounts are not proof of operational readiness. |

## Assumptions and decision boundary

Transport security, access to the host and identity security are dependencies, not guarantees created
by this ADR. Public content and shared media can already be copied. A reporter's identity may be
inferred, even if it is never disclosed by the API. Retaining a selected message after source
deletion is a material privacy choice, not merely an implementation detail. Reports are not proof,
and a delay while independent review is unavailable may harm either party.

Before acceptance, reviewers must resolve or explicitly gate ADR 0026 P1–P10 and decide whether these
residual risks are tolerable. Before collecting real reports, all release gates must be met and the
privacy notices, controls, operational staff and retention runbooks must actually exist. This
proposal creates no new privilege, database, REST route, deployment or promise of legal compliance.
