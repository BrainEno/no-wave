import assert from "node:assert/strict";
import test from "node:test";
import { handoffFixture } from "../infrastructure/test-support/alert-handoff-fixture.ts";
import { parseHandoffVerificationConfig } from "../infrastructure/alert-handoff-config.ts";
import {
  HandoffFault,
  createHandoffBatch,
  createHandoffReceipt,
} from "./alert-handoff-protocol.ts";
import {
  handoffVerificationDocument,
  verifyAlertHandoffEvidence,
} from "./alert-handoff-verification.ts";

const fault = (code: string) => (error: unknown) =>
  error instanceof HandoffFault && error.code === code;
test("a public-only verifier authenticates batch and optional exact receipt without access to either private key", () => {
  const f = handoffFixture(),
    document = handoffVerificationDocument(f.sender);
  assert.deepEqual(Object.keys(document).sort(), [
    "receiverId",
    "receiverKey",
    "role",
    "senderKey",
    "streamId",
    "version",
  ]);
  const profile = parseHandoffVerificationConfig(document);
  assert.equal(profile.senderKey.type, "public");
  assert.equal(profile.receiverKey.type, "public");
  assert.equal("privateKey" in profile, false);
  const batch = createHandoffBatch(
    f.sender,
    f.monitor.events,
    f.monitor.fingerprint,
    1,
    null,
    f.now,
  );
  const receipt = createHandoffReceipt(f.inbox, batch, f.now + 1, 1);
  const unsignedDelivery = verifyAlertHandoffEvidence(
    profile,
    batch,
    null,
    f.now + 1000,
  );
  assert.equal(unsignedDelivery.evidence, "signatures_only");
  assert.equal(unsignedDelivery.receiptProof, "not_provided");
  assert.equal(unsignedDelivery.oldestEventAgeMs, 1000);
  assert.equal(unsignedDelivery.transitions.firing, 1);
  const result = verifyAlertHandoffEvidence(
    profile,
    batch,
    receipt,
    f.now + 1000,
  );
  assert.equal(result.receiptProof, "durable_acceptance");
  assert.equal(result.receiptAcceptanceAgeMs, 999);
  assert.equal(result.critical, 1);
  assert.equal(result.targets, 1);
  assert.doesNotMatch(
    JSON.stringify(document) + JSON.stringify(result),
    /signingKey|privateKey|PRIVATE KEY|metricsUrl/,
  );
  assert.equal(
    verifyAlertHandoffEvidence(profile, batch, receipt, f.now + 86_400_000)
      .oldestEventAgeMs,
    86_400_000,
  );
});

test("verification rejects peer substitution, extra/private profile fields, mismatched receipts and future evidence", () => {
  const f = handoffFixture(),
    document = handoffVerificationDocument(f.sender),
    profile = parseHandoffVerificationConfig(document);
  for (const patch of [
    { signingKey: f.senderDocument.signingKey },
    { senderKey: document.receiverKey },
    { senderKey: f.senderDocument.signingKey },
    { streamId: document.receiverId },
  ]) {
    assert.throws(
      () => parseHandoffVerificationConfig({ ...document, ...patch }),
      fault("config_invalid"),
    );
  }
  const batch = createHandoffBatch(
    f.sender,
    f.monitor.events,
    f.monitor.fingerprint,
    1,
    null,
    f.now,
  );
  const receipt = createHandoffReceipt(f.inbox, batch, f.now + 1, 1);
  assert.throws(
    () => verifyAlertHandoffEvidence(profile, batch, receipt, f.now - 1),
    fault("clock_rollback"),
  );
  assert.throws(
    () => verifyAlertHandoffEvidence(profile, batch, receipt, f.now),
    fault("clock_rollback"),
  );
  const fork = createHandoffBatch(
    f.sender,
    f.monitor.events,
    f.monitor.fingerprint,
    1,
    null,
    f.now + 2,
  );
  assert.throws(
    () => verifyAlertHandoffEvidence(profile, fork, receipt, f.now + 3),
    fault("artifact_invalid"),
  );
  const backdated = createHandoffReceipt(f.inbox, batch, f.now - 1, 1);
  assert.throws(
    () => verifyAlertHandoffEvidence(profile, batch, backdated, f.now + 3),
    fault("artifact_invalid"),
  );
});
