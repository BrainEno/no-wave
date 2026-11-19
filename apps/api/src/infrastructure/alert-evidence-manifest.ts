import {
  HANDOFF_HASH,
  handoffFields,
} from "../application/alert-handoff-protocol.ts";
import {
  AlertEvidenceFault,
  EVIDENCE_LIMITS,
} from "../application/alert-evidence.ts";

export type AlertEvidenceManifest = {
  version: 1;
  artifacts: { kind: "batch" | "receipt"; file: string; sha256: string }[];
};

/** A manifest names only portable relative files beneath its own private
 * directory. There is no URL, glob, recursion, environment or key discovery. */
export function evidenceRelativeFile(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240)
    throw new AlertEvidenceFault("manifest_invalid");
  const components = value.split("/");
  if (
    components.length > 4 ||
    components.some(
      (part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part),
    ) ||
    !components.at(-1)!.endsWith(".json")
  )
    throw new AlertEvidenceFault("manifest_invalid");
  return value;
}
export function parseAlertEvidenceManifest(
  value: unknown,
): AlertEvidenceManifest {
  try {
    const row = handoffFields(
      value,
      ["version", "artifacts"],
      "artifact_invalid",
    );
    if (row.version !== 1 || !Array.isArray(row.artifacts))
      throw new AlertEvidenceFault("manifest_invalid");
    if (row.artifacts.length > EVIDENCE_LIMITS.artifacts)
      throw new AlertEvidenceFault("budget_exceeded");
    const seen = new Set<string>();
    const artifacts: AlertEvidenceManifest["artifacts"] = [];
    for (const value of row.artifacts) {
      const item = handoffFields(
        value,
        ["kind", "file", "sha256"],
        "artifact_invalid",
      );
      if (item.kind !== "batch" && item.kind !== "receipt")
        throw new AlertEvidenceFault("manifest_invalid");
      const file = evidenceRelativeFile(item.file);
      if (
        typeof item.sha256 !== "string" ||
        !HANDOFF_HASH.test(item.sha256) ||
        seen.has(file)
      )
        throw new AlertEvidenceFault("manifest_invalid");
      seen.add(file);
      artifacts.push({ kind: item.kind, file, sha256: item.sha256 });
    }
    return { version: 1, artifacts };
  } catch (error) {
    if (error instanceof AlertEvidenceFault) throw error;
    throw new AlertEvidenceFault("manifest_invalid");
  }
}
