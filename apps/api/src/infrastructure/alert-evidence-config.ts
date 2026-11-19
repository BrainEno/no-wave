import {
  handoffFields,
  handoffHash,
} from "../application/alert-handoff-protocol.ts";
import {
  AlertEvidenceFault,
  type AlertEvidenceTrust,
} from "../application/alert-evidence.ts";
import { parseHandoffVerificationConfig } from "./alert-handoff-config.ts";

/** Public trust is supplied independently of the evidence manifest. Existing
 * verifier profiles keep their v1 schema; no private runtime config is accepted. */
export function parseAlertEvidenceTrust(value: unknown): AlertEvidenceTrust {
  try {
    const row = handoffFields(
      value,
      ["version", "role", "profiles"],
      "config_invalid",
    );
    if (
      row.version !== 1 ||
      row.role !== "evidence-review" ||
      !Array.isArray(row.profiles) ||
      row.profiles.length < 1 ||
      row.profiles.length > 16
    )
      throw new AlertEvidenceFault("trust_invalid");
    const profiles = row.profiles
      .map(parseHandoffVerificationConfig)
      .sort((a, b) =>
        a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0,
      );
    const receiverId = profiles[0]!.receiverId;
    const receiverKey = profiles[0]!.receiverKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    const streams = new Set<string>(),
      senders = new Set<string>();
    for (const profile of profiles) {
      const senderKey = profile.senderKey
        .export({ type: "spki", format: "der" })
        .toString("base64");
      if (
        profile.receiverId !== receiverId ||
        profile.receiverKey
          .export({ type: "spki", format: "der" })
          .toString("base64") !== receiverKey ||
        streams.has(profile.streamId) ||
        senders.has(senderKey)
      )
        throw new AlertEvidenceFault("trust_invalid");
      streams.add(profile.streamId);
      senders.add(senderKey);
    }
    return {
      profiles,
      byStream: new Map(profiles.map((profile) => [profile.streamId, profile])),
      receiverId,
      fingerprint: handoffHash([
        "no-wave-alert-evidence-trust-v1",
        profiles.map((profile) => profile.fingerprint),
      ]),
    };
  } catch {
    throw new AlertEvidenceFault("trust_invalid");
  }
}
