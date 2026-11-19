import { handoffFixture } from "./alert-handoff-fixture.ts";
import {
  parseHandoffInboxConfig,
  parseHandoffSenderConfig,
} from "../alert-handoff-config.ts";
import { handoffVerificationDocument } from "../../application/alert-handoff-verification.ts";
import {
  createHandoffBatch,
  createHandoffReceipt,
  handoffHash,
  type HandoffBatch,
  type HandoffReceipt,
} from "../../application/alert-handoff-protocol.ts";
import type { MonitorEvent } from "../../application/operational-monitor.ts";

export function alertEvidenceFixture() {
  const first = handoffFixture(),
    other = handoffFixture();
  const second = parseHandoffSenderConfig({
    ...other.senderDocument,
    receiverId: first.sender.receiverId,
    receiverKey: first.senderDocument.receiverKey,
  });
  const senders = [first.sender, second];
  const inbox = parseHandoffInboxConfig({
    ...first.inboxDocument,
    sources: senders.map((sender) => ({
      streamId: sender.streamId,
      publicKey: sender.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    })),
  });
  const trustDocument = {
    version: 1,
    role: "evidence-review",
    profiles: senders.map(handoffVerificationDocument),
  };
  function event(
    revision: number,
    transition: MonitorEvent["transition"],
    patch: Partial<MonitorEvent> = {},
  ) {
    const at = first.now + (revision - 1) * 30_000;
    const value: MonitorEvent = {
      ...first.monitor.events[0]!,
      revision,
      transition,
      at,
      firingSince: transition === "firing" ? at : first.now,
      reason: transition === "resolved" ? "within_threshold" : "breached",
      value: transition === "resolved" ? 0 : 1,
      ...patch,
    };
    value.id = handoffHash([
      first.monitor.fingerprint,
      value.revision,
      value.targetId,
      value.rule,
      value.transition,
      value.at,
    ]);
    return value;
  }
  function batch(
    source: number,
    sequence: number,
    previous: HandoffBatch | null,
    patch: {
      event?: MonitorEvent;
      preparedAt?: number;
      previousId?: string;
      fingerprint?: string;
    } = {},
  ) {
    const fact =
      patch.event ??
      event(sequence * 2 - 1, sequence === 1 ? "firing" : "reminder");
    return createHandoffBatch(
      senders[source]!,
      [fact],
      patch.fingerprint ?? first.monitor.fingerprint,
      sequence,
      patch.previousId ?? previous?.id ?? null,
      patch.preparedAt ?? fact.at + 10,
    );
  }
  function receipt(
    batch: HandoffBatch,
    inboxRevision = batch.sequence,
    acceptedAt = batch.preparedAt + 10,
  ) {
    return createHandoffReceipt(inbox, batch, acceptedAt, inboxRevision);
  }
  const now = first.now + 900_000;
  return {
    ...first,
    senders,
    sharedInbox: inbox,
    trustDocument,
    event,
    batch,
    receipt,
    reportedAt: now,
  };
}
export function evidenceInputs(
  batches: HandoffBatch[],
  receipts: HandoffReceipt[] = [],
) {
  return [
    ...batches.map((batch) => ({
      kind: "batch" as const,
      bytes: Buffer.from(JSON.stringify(batch) + "\n"),
    })),
    ...receipts.map((receipt) => ({
      kind: "receipt" as const,
      bytes: Buffer.from(JSON.stringify(receipt) + "\n"),
    })),
  ];
}
