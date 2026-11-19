import {
  HandoffFault,
  parseHandoffBatch,
  verifyHandoffReceipt,
  type HandoffSenderConfig,
  type HandoffVerificationConfig,
} from "./alert-handoff-protocol.ts";

/** A deliberately separate public profile: exporting this object must never
 * spread a runtime sender config, which also owns a private KeyObject. */
export function handoffVerificationDocument(config: HandoffSenderConfig) {
  return {
    version: 1,
    role: "verify",
    streamId: config.streamId,
    receiverId: config.receiverId,
    senderKey: config.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    receiverKey: config.receiverKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

/** Public-only offline review. Old authentic evidence is still authentic, but
 * all event/preparation/acceptance ages remain visible. No validity result here
 * means current service health, delivery freshness or a human notification. */
export function verifyAlertHandoffEvidence(
  config: HandoffVerificationConfig,
  batchValue: unknown,
  receiptValue: unknown | null,
  now: number,
) {
  const batch = parseHandoffBatch(
    batchValue,
    config.senderKey,
    config.streamId,
    config.receiverId,
  );
  const receipt =
    receiptValue === null
      ? null
      : verifyHandoffReceipt(receiptValue, config, batch);
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now < batch.preparedAt ||
    now < (receipt?.acceptedAt ?? 0)
  )
    throw new HandoffFault("clock_rollback");
  const targets = new Set<string>();
  let critical = 0,
    warning = 0;
  let firing = 0,
    reminder = 0,
    resolved = 0;
  let oldestEventAt = Number.MAX_SAFE_INTEGER,
    newestEventAt = 0;
  let oldestFiringSince = Number.MAX_SAFE_INTEGER,
    firstRevision = Number.MAX_SAFE_INTEGER,
    lastRevision = 0;
  let unknownFacts = 0;
  for (const event of batch.events) {
    targets.add(event.targetId);
    if (event.severity === "critical") critical++;
    else warning++;
    switch (event.transition) {
      case "firing":
        firing++;
        break;
      case "reminder":
        reminder++;
        break;
      case "resolved":
        resolved++;
        break;
    }
    if (event.at < oldestEventAt) oldestEventAt = event.at;
    if (event.at > newestEventAt) newestEventAt = event.at;
    if (event.firingSince < oldestFiringSince)
      oldestFiringSince = event.firingSince;
    if (event.revision < firstRevision) firstRevision = event.revision;
    if (event.revision > lastRevision) lastRevision = event.revision;
    if (event.value === null) unknownFacts++;
  }
  return {
    version: 1,
    event: "alert_handoff_verified",
    evidence: "signatures_only",
    reportedAt: now,
    batchId: batch.id,
    streamId: batch.streamId,
    receiverId: batch.receiverId,
    sequence: batch.sequence,
    previousBatchId: batch.previous,
    monitorFingerprint: batch.monitorFingerprint,
    count: batch.events.length,
    targets: targets.size,
    critical,
    warning,
    transitions: { firing, reminder, resolved },
    unknownFacts,
    firstRevision,
    lastRevision,
    oldestEventAt,
    newestEventAt,
    oldestFiringSince,
    oldestEventAgeMs: now - oldestEventAt,
    newestEventAgeMs: now - newestEventAt,
    preparedAt: batch.preparedAt,
    preparationAgeMs: now - batch.preparedAt,
    receiptProof: receipt === null ? "not_provided" : "durable_acceptance",
    acceptedAt: receipt?.acceptedAt ?? null,
    receiptAcceptanceAgeMs: receipt === null ? null : now - receipt.acceptedAt,
    inboxRevision: receipt?.inboxRevision ?? null,
  };
}
