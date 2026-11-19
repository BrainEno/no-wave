import { generateKeyPairSync, randomUUID } from "node:crypto";
import { evaluateMonitor } from "../../application/operational-alerts.ts";
import type { MonitorState } from "../../application/operational-monitor.ts";
import { parseMonitorConfig } from "../monitor-config.ts";
import { parseHandoffInboxConfig, parseHandoffSenderConfig } from "../alert-handoff-config.ts";

export function handoffFixture() {
  const senderKeys = generateKeyPairSync("ed25519"), inboxKeys = generateKeyPairSync("ed25519");
  const streamId = randomUUID(), receiverId = randomUUID();
  const senderDocument = {
    version: 1, role: "sender", streamId, receiverId,
    signingKey: senderKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    receiverKey: inboxKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
  const inboxDocument = {
    version: 1, role: "inbox", receiverId,
    signingKey: inboxKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    sources: [{ streamId, publicKey: senderKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64") }],
  };
  const monitorConfig = parseMonitorConfig({
    version: 1,
    targets: [{ id: "worker-one", role: "notification-worker", metricsUrl: "http://127.0.0.1:9100/metrics" }],
    rules: { target_unavailable: { forMs: 0, resolveMs: 0, repeatMs: 30_000 } },
  });
  const now = 1_800_000_000_000;
  function observe(previous: MonitorState | null = null, at = now) {
    return evaluateMonitor(monitorConfig, previous, [{ targetId: "worker-one", observedAt: at, reason: "timeout", snapshot: null }], at).state;
  }
  return {
    sender: parseHandoffSenderConfig(senderDocument), inbox: parseHandoffInboxConfig(inboxDocument),
    senderDocument, inboxDocument, monitorConfig, monitor: observe(), now, observe,
  };
}
