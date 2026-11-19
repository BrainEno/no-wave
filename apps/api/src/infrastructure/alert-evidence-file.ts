import { createHash } from "node:crypto";
import { lstatSync, type Stats } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  AlertEvidenceFault,
  EVIDENCE_LIMITS,
  type AlertEvidenceFaultCode,
  type EvidenceInput,
} from "../application/alert-evidence.ts";
import { handoffJson } from "../application/alert-handoff-protocol.ts";
import { parseAlertEvidenceTrust } from "./alert-evidence-config.ts";
import { parseAlertEvidenceManifest } from "./alert-evidence-manifest.ts";
import {
  assertPrivateOperationParent,
  privateOperationPath,
  readPrivateOperationFile,
} from "./private-operation-file.ts";

function bytesHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function identityUnchanged(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/** Reuse the journal's NOFOLLOW/NONBLOCK, ownership, single-link and private
 * permission checks. Metadata stability is an additional conservative guard,
 * not a same-UID MAC or a multi-file atomic snapshot guarantee. */
export function readStableEvidenceFile(
  pathValue: string,
  maximum: number,
): Buffer {
  try {
    const path = privateOperationPath(pathValue);
    assertPrivateOperationParent(path);
    const before = lstatSync(path);
    if (before.isFile() && before.size > maximum)
      throw new AlertEvidenceFault("budget_exceeded");
    const bytes = readPrivateOperationFile(path, {
      maximum,
      privateFile: true,
    })!;
    assertPrivateOperationParent(path);
    const after = lstatSync(path);
    if (!identityUnchanged(before, after) || bytes.length !== after.size)
      throw new AlertEvidenceFault("snapshot_changed");
    return bytes;
  } catch (error) {
    if (error instanceof AlertEvidenceFault) throw error;
    throw new AlertEvidenceFault("file_io");
  }
}
function decode(bytes: Buffer, code: AlertEvidenceFaultCode): unknown {
  try {
    return handoffJson(bytes, "artifact_invalid");
  } catch {
    throw new AlertEvidenceFault(code);
  }
}
function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AlertEvidenceFault("cancelled");
}
function controlPath(value: string): string {
  try {
    return privateOperationPath(value);
  } catch {
    throw new AlertEvidenceFault("arguments_invalid");
  }
}
type Read = (path: string, maximum: number) => Buffer;
type Collection = { inputs: EvidenceInput[]; manifestId: string };
type Frame = {
  path: string;
  bytes: Buffer;
  artifacts: { path: string; sha256: string; length: number }[];
};

/** Load one review or both comparison sides under the same pinned public
 * trust. Every named input is checked again before release. No directories are
 * scanned and no locks, state, acknowledgment or output artifacts are written. */
export function loadAlertEvidenceFiles(
  trustPathValue: string,
  manifestPathValues: readonly string[],
  dependencies: {
    read?: Read;
    signal?: AbortSignal;
    requirementsPath?: string;
  } = {},
) {
  if (
    !Array.isArray(manifestPathValues) ||
    manifestPathValues.length < 1 ||
    manifestPathValues.length > 2
  )
    throw new AlertEvidenceFault("arguments_invalid");
  const trustPath = controlPath(trustPathValue),
    manifestPaths = manifestPathValues.map(controlPath);
  if (manifestPaths.includes(trustPath))
    throw new AlertEvidenceFault("arguments_invalid");
  const requirementsPath =
    dependencies.requirementsPath === undefined
      ? null
      : controlPath(dependencies.requirementsPath);
  if (
    requirementsPath !== null &&
    (requirementsPath === trustPath || manifestPaths.includes(requirementsPath))
  )
    throw new AlertEvidenceFault("arguments_invalid");
  const controls = new Set([
    trustPath,
    ...manifestPaths,
    ...(requirementsPath === null ? [] : [requirementsPath]),
  ]);
  const reader = dependencies.read ?? readStableEvidenceFile;
  const read = (path: string, maximum: number) => {
    cancelled(dependencies.signal);
    if (maximum < 1) throw new AlertEvidenceFault("budget_exceeded");
    const bytes = reader(path, maximum);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximum)
      throw new AlertEvidenceFault("budget_exceeded");
    cancelled(dependencies.signal);
    return bytes;
  };
  const trustBytes = read(trustPath, EVIDENCE_LIMITS.trustBytes);
  const trust = parseAlertEvidenceTrust(decode(trustBytes, "trust_invalid"));
  const requirementsBytes =
    requirementsPath === null
      ? null
      : read(requirementsPath, EVIDENCE_LIMITS.requirementsBytes);
  const frames: Frame[] = [];
  const collections: Collection[] = [];
  for (const path of manifestPaths) {
    const bytes = read(path, EVIDENCE_LIMITS.manifestBytes);
    const manifest = parseAlertEvidenceManifest(
      decode(bytes, "manifest_invalid"),
    );
    const frame: Frame = { path, bytes, artifacts: [] };
    const root = dirname(path);
    const inputs: EvidenceInput[] = [];
    let total = 0;
    for (const item of manifest.artifacts) {
      const artifactPath = resolve(root, item.file);
      if (!artifactPath.startsWith(root + sep) || controls.has(artifactPath))
        throw new AlertEvidenceFault("manifest_invalid");
      const artifact = read(
        artifactPath,
        Math.min(
          EVIDENCE_LIMITS.artifactBytes,
          EVIDENCE_LIMITS.totalBytes - total,
        ),
      );
      const digest = bytesHash(artifact);
      if (digest !== item.sha256)
        throw new AlertEvidenceFault("integrity_mismatch");
      total += artifact.length;
      frame.artifacts.push({
        path: artifactPath,
        sha256: digest,
        length: artifact.length,
      });
      inputs.push({ kind: item.kind, bytes: artifact });
    }
    frames.push(frame);
    collections.push({ inputs, manifestId: bytesHash(bytes) });
  }
  // A before/after pair is not permitted to observe two different trust files.
  // Byte-identical controls are required even if a rewrite is semantically equal.
  if (!read(trustPath, EVIDENCE_LIMITS.trustBytes).equals(trustBytes))
    throw new AlertEvidenceFault("snapshot_changed");
  for (const frame of frames) {
    for (const item of frame.artifacts) {
      const observed = read(item.path, EVIDENCE_LIMITS.artifactBytes);
      if (
        observed.length !== item.length ||
        bytesHash(observed) !== item.sha256
      )
        throw new AlertEvidenceFault("snapshot_changed");
    }
    if (!read(frame.path, EVIDENCE_LIMITS.manifestBytes).equals(frame.bytes))
      throw new AlertEvidenceFault("snapshot_changed");
  }
  if (
    requirementsPath !== null &&
    !read(requirementsPath, EVIDENCE_LIMITS.requirementsBytes).equals(
      requirementsBytes!,
    )
  )
    throw new AlertEvidenceFault("snapshot_changed");
  cancelled(dependencies.signal);
  return {
    trust,
    collections,
    requirements:
      requirementsBytes === null
        ? null
        : decode(requirementsBytes, "requirements_invalid"),
    snapshot: "non_atomic_file_evidence" as const,
  };
}
