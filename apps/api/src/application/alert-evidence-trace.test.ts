import assert from "node:assert/strict";
import test from "node:test";
import {
  alertEvidenceFixture,
  evidenceInputs,
} from "../infrastructure/test-support/alert-evidence-fixture.ts";
import { parseAlertEvidenceTrust } from "../infrastructure/alert-evidence-config.ts";
import { traceAlertEvidence } from "./alert-evidence-trace.ts";
import {
  createHandoffBatch,
  handoffHash,
  type HandoffBatch,
} from "./alert-handoff-protocol.ts";

function fixture() {
  const f = alertEvidenceFixture();
  const trust = parseAlertEvidenceTrust({
    ...f.trustDocument,
    profiles: [f.trustDocument.profiles[0]],
  });
  const one = f.batch(0, 1, null),
    two = f.batch(0, 2, one);
  const three = f.batch(0, 3, two, { event: f.event(5, "resolved") });
  const inputs = evidenceInputs(
    [one, two, three],
    [f.receipt(one), f.receipt(two), f.receipt(three)],
  );
  return {
    ...f,
    trust,
    one,
    two,
    three,
    inputs,
    options: { now: f.reportedAt },
  };
}

test("trace pages are tied to the authenticated set and exact selection, not file order or a private signing key", () => {
  const f = fixture();
  const first = traceAlertEvidence(f.trust, f.inputs, { limit: 1 }, f.options);
  assert.equal(first.exitCode, 0);
  assert.equal(first.matched, 3);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0]!.kind, "event");
  assert.ok(first.continuation);
  assert.equal(first.cursorAuthentication, "not_an_authorization_token");
  const second = traceAlertEvidence(
    f.trust,
    [...f.inputs].reverse(),
    { limit: 1, after: first.continuation },
    f.options,
  );
  assert.notEqual(second.entries[0]!.rowId, first.entries[0]!.rowId);
  const last = traceAlertEvidence(
    f.trust,
    f.inputs,
    { limit: 1, after: second.continuation },
    f.options,
  );
  assert.equal(last.continuation, null);
  assert.equal(last.entries[0]!.kind, "event");
  const changed = evidenceInputs(
    [f.one, f.two, f.three],
    [f.receipt(f.one), f.receipt(f.two)],
  );
  assert.throws(
    () =>
      traceAlertEvidence(
        f.trust,
        changed,
        { limit: 1, after: first.continuation },
        f.options,
      ),
    { code: "page_stale" },
  );
  assert.throws(
    () =>
      traceAlertEvidence(
        f.trust,
        f.inputs,
        { limit: 2, after: first.continuation },
        f.options,
      ),
    { code: "page_stale" },
  );
  assert.throws(
    () =>
      traceAlertEvidence(
        f.trust,
        f.inputs,
        { limit: 1, after: "arbitrary==" },
        f.options,
      ),
    { code: "cursor_invalid" },
  );
  const cursor = JSON.parse(
    Buffer.from(first.continuation!, "base64url").toString("utf8"),
  );
  cursor.rowId = "a".repeat(64);
  assert.throws(
    () =>
      traceAlertEvidence(
        f.trust,
        f.inputs,
        {
          limit: 1,
          after: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
        },
        f.options,
      ),
    { code: "cursor_invalid" },
  );
});

test("event context exposes only provided neighbors, their signed linkage and matching receipt claims", () => {
  const f = fixture();
  const result = traceAlertEvidence(
    f.trust,
    f.inputs,
    { fromAt: f.two.events[0]!.at, throughAt: f.two.events[0]!.at },
    f.options,
  );
  assert.equal(result.entries.length, 1);
  const entry = result.entries[0]!;
  assert.equal(entry.kind, "event");
  if (entry.kind !== "event") throw new Error("wrong trace view");
  assert.equal(entry.event.id, f.two.events[0]!.id);
  assert.equal(entry.previous!.eventId, f.one.events[0]!.id);
  assert.equal(entry.previous!.linkage, "linked_batches");
  assert.equal(entry.next!.eventId, f.three.events[0]!.id);
  assert.equal(entry.receiptProof, "matching_signed_claim");
  const gap = traceAlertEvidence(
    f.trust,
    evidenceInputs([f.one, f.three], [f.receipt(f.one), f.receipt(f.three)]),
    { fromSequence: 3 },
    f.options,
  );
  assert.equal(gap.entries[0]!.kind, "event");
  if (gap.entries[0]!.kind === "event")
    assert.equal(gap.entries[0]!.previous!.linkage, "unproven");
  assert.equal(gap.exitCode, 1);
});

test("a narrow event or finding filter never hides the global review's contradictions or turns empty results healthy", () => {
  const f = fixture(),
    fork = f.batch(0, 2, f.one, { preparedAt: f.two.preparedAt + 1 });
  const inputs = evidenceInputs(
    [f.one, f.two, fork],
    [f.receipt(f.one), f.receipt(f.two)],
  );
  const result = traceAlertEvidence(
    f.trust,
    inputs,
    { throughSequence: 1 },
    f.options,
  );
  assert.equal(result.entries.length, 1);
  assert.equal(result.exitCode, 1);
  assert.ok(result.globalReview.findingTotals.conflicts > 0);
  const empty = traceAlertEvidence(
    f.trust,
    inputs,
    { targetId: "not-provided" },
    f.options,
  );
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.exitCode, 1);
  const findings = traceAlertEvidence(
    f.trust,
    inputs,
    { view: "findings", severity: "conflict" },
    f.options,
  );
  assert.ok(findings.entries.length > 0);
  assert.ok(
    findings.entries.every(
      (entry) =>
        entry.kind === "finding" && entry.finding.severity === "conflict",
    ),
  );
});

test("exact batch and event selectors locate authenticated facts without discarding the global review", () => {
  const f = fixture();
  const selected = traceAlertEvidence(
    f.trust,
    f.inputs,
    { batchId: f.two.id, eventId: f.two.events[0]!.id },
    f.options,
  );
  assert.equal(selected.matched, 1);
  assert.equal(selected.entries[0]!.kind, "event");
  if (selected.entries[0]!.kind === "event")
    assert.equal(selected.entries[0]!.batchId, f.two.id);
  assert.equal(selected.globalReview.stats.batches, 3);
  assert.equal(
    traceAlertEvidence(
      f.trust,
      f.inputs,
      { eventId: "a".repeat(64) },
      f.options,
    ).matched,
    0,
  );
  const missingReceipt = traceAlertEvidence(
    f.trust,
    evidenceInputs([f.one, f.two]),
    {
      view: "findings",
      batchId: f.two.id,
      code: "receipt_missing",
    },
    f.options,
  );
  assert.equal(missingReceipt.matched, 1);
  assert.equal(missingReceipt.globalReview.stats.missingReceipts, 2);
  for (const query of [{ batchId: "A".repeat(64) }, { eventId: "not-an-id" }])
    assert.throws(
      () => traceAlertEvidence(f.trust, f.inputs, query, f.options),
      { code: "arguments_invalid" },
    );
});

test("related findings use every admitted receipt claim rather than only the displayed claim sample", () => {
  const f = fixture();
  const receipts = Array.from({ length: 5 }, (_, index) =>
    f.receipt(
      f.one,
      index + 1,
      index === 4 ? f.two.preparedAt + 50 : f.one.preparedAt + 10 + index,
    ),
  );
  const page = traceAlertEvidence(
    f.trust,
    evidenceInputs([f.one, f.two], [...receipts, f.receipt(f.two, 6)]),
    {
      throughSequence: 1,
    },
    f.options,
  );
  const entry = page.entries[0]!;
  assert.equal(entry.kind, "event");
  if (entry.kind !== "event") throw new Error("wrong trace view");
  assert.equal(entry.signedReceiptClaims.length, 4);
  assert.equal(entry.receiptClaimsTruncated, true);
  assert.ok(
    page.relatedFindings!.findings.some(
      (finding) => finding.code === "preparation_before_previous_acceptance",
    ),
  );
  assert.equal(page.exitCode, 1);
});

test("context distinguishes missing, ambiguous and contradictory signed receipt claims", () => {
  const f = fixture();
  const contradictory = f.receipt(
    { ...f.one, events: [...f.one.events, ...f.two.events] },
    8,
  );
  const cases = [
    { receipts: [], proof: "none" },
    { receipts: [f.receipt(f.one), f.receipt(f.one, 7)], proof: "ambiguous" },
    { receipts: [f.receipt(f.one), contradictory], proof: "contradictory" },
  ];
  for (const { receipts, proof } of cases) {
    const result = traceAlertEvidence(
      f.trust,
      evidenceInputs([f.one], receipts),
      {},
      f.options,
    );
    const entry = result.entries[0]!;
    assert.equal(entry.kind, "event");
    if (entry.kind !== "event") throw new Error("wrong trace view");
    assert.equal(entry.receiptProof, proof);
    assert.equal(result.exitCode, 1);
  }
});

test("selection and forged navigation never bypass authentication or erase global findings", () => {
  const f = fixture();
  const withGap = evidenceInputs([f.one, f.two, f.three]);
  const first = traceAlertEvidence(f.trust, withGap, { limit: 1 }, f.options);
  const full = traceAlertEvidence(f.trust, withGap, {}, f.options);
  const cursor = JSON.parse(
    Buffer.from(first.continuation!, "base64url").toString("utf8"),
  );
  cursor.rowId = full.entries.at(-1)!.rowId;
  const skipped = traceAlertEvidence(
    f.trust,
    withGap,
    {
      limit: 1,
      after: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
    },
    f.options,
  );
  assert.equal(skipped.entries.length, 0);
  assert.equal(skipped.exitCode, 1);
  assert.equal(skipped.globalReview.stats.missingReceipts, 3);
  assert.throws(
    () =>
      traceAlertEvidence(
        f.trust,
        [
          ...f.inputs,
          {
            kind: "batch",
            bytes: Buffer.from(
              JSON.stringify({ ...f.one, preparedAt: f.one.preparedAt + 1 }),
            ),
          },
        ],
        { targetId: "no-results" },
        f.options,
      ),
    { code: "artifact_invalid" },
  );
  assert.throws(
    () =>
      traceAlertEvidence(
        parseAlertEvidenceTrust(f.trustDocument),
        withGap,
        {
          limit: 1,
          after: first.continuation,
        },
        f.options,
      ),
    { code: "page_stale" },
  );
});

test("configuration changes do not manufacture episode neighbors across monitor identities", () => {
  const f = fixture(),
    fingerprint = "a".repeat(64);
  const event = f.event(3, "reminder");
  event.id = handoffHash([
    fingerprint,
    event.revision,
    event.targetId,
    event.rule,
    event.transition,
    event.at,
  ]);
  const changed = f.batch(0, 2, f.one, { event, fingerprint });
  const result = traceAlertEvidence(
    f.trust,
    evidenceInputs([f.one, changed]),
    {},
    f.options,
  );
  assert.equal(result.entries.length, 2);
  for (const entry of result.entries) {
    assert.equal(entry.kind, "event");
    if (entry.kind === "event") {
      assert.equal(entry.previous, null);
      assert.equal(entry.next, null);
    }
  }
  assert.ok(
    result.globalReview.findings.some(
      (finding) => finding.code === "monitor_configuration_changed",
    ),
  );
  assert.ok(
    result.globalReview.findings.some(
      (finding) => finding.code === "episode_origin_unproven",
    ),
  );
});

test("finding pagination can inspect issues omitted by the bounded global sample", () => {
  const f = fixture();
  const batches: HandoffBatch[] = [];
  for (let sequence = 1; sequence <= 140; sequence++)
    batches.push(
      f.batch(0, sequence, batches.at(-1) ?? null, {
        event: f.event(sequence * 2 - 1, "firing"),
      }),
    );
  const inputs = evidenceInputs(batches),
    options = { now: f.now + 9_000_000 };
  const query = {
    view: "findings",
    code: "episode_start_while_open",
    limit: 17,
  };
  const ids = new Set<string>();
  let after: string | null = null;
  let pages = 0;
  do {
    const page = traceAlertEvidence(
      f.trust,
      inputs,
      { ...query, after },
      options,
    );
    assert.equal(page.globalReview.findingTotals.truncated, true);
    assert.equal(page.matched, 139);
    for (const entry of page.entries) {
      assert.equal(ids.has(entry.rowId), false);
      ids.add(entry.rowId);
    }
    after = page.continuation;
    pages++;
    assert.ok(pages < 12);
  } while (after !== null);
  assert.equal(ids.size, 139);
});

test("trace validates selectors, canonical cursors and mutually exclusive view semantics", () => {
  const f = fixture();
  for (const query of [
    { limit: 0 },
    { limit: 129 },
    { limit: 1.1 },
    { streamId: f.senders[1]!.streamId },
    { targetId: "../private" },
    { rule: "unknown" },
    { transition: "acknowledged" },
    { fromAt: -1 },
    { fromAt: f.reportedAt + 1 },
    { fromAt: 20, throughAt: 10 },
    { fromSequence: 0 },
    { fromSequence: 2, throughSequence: 1 },
    { view: "findings", targetId: "worker-one" },
    { view: "events", severity: "conflict" },
    { view: "findings", code: "unrecognized" },
    { view: "unknown" },
    { after: "a".repeat(2049) },
    { signingKey: "private-trace-canary" },
  ])
    assert.throws(() =>
      traceAlertEvidence(f.trust, f.inputs, query, f.options),
    );
});

test("same-batch neighbors and identical event IDs from different streams remain distinguishable", () => {
  const f = fixture(),
    other = f.batch(1, 1, null);
  const trust = parseAlertEvidenceTrust(f.trustDocument);
  const multi = createHandoffBatch(
    f.senders[0]!,
    [f.event(1, "firing"), f.event(3, "reminder")],
    f.monitor.fingerprint,
    1,
    null,
    f.now + 70_000,
  );
  const result = traceAlertEvidence(
    trust,
    evidenceInputs(
      [multi, other],
      [f.receipt(multi, 2, multi.preparedAt + 1), f.receipt(other, 1)],
    ),
    { streamId: multi.streamId },
    f.options,
  );
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]!.kind, "event");
  if (result.entries[0]!.kind === "event")
    assert.equal(result.entries[0]!.next!.linkage, "same_batch");
  assert.notEqual(
    handoffHash([multi.streamId, multi.events[0]!.id]),
    handoffHash([other.streamId, other.events[0]!.id]),
  );
});
