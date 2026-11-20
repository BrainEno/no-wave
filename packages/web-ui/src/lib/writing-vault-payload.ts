import { parseWritingBackup, type WritingBackup } from "./writing-backup.ts";
import {
  parseWritingCollection,
  readCollectionJson,
} from "./writing-collection.ts";
import { writingRecord } from "./writing-document.ts";
import {
  parseWritingMergePlan,
  type WritingMergePlan,
} from "./writing-merge-plan.ts";
import {
  VaultError,
  vaultActive,
  vaultDecode,
  vaultSize,
  type VaultBytes,
} from "./writing-vault-format.ts";

export type VaultDocument = {
  id: string;
  group: string;
  backup: WritingBackup;
};
export type VaultReview = {
  kind: "backup" | "collection" | "merge-plan";
  bytes: number;
  digest: string;
  documents: VaultDocument[];
  plan: WritingMergePlan | null;
};

/** A byte witness, deliberately different from the collection's canonical-JSON checksum. */
export async function digestVaultBytes(
  bytes: VaultBytes,
  signal?: AbortSignal,
): Promise<string> {
  vaultActive(signal);
  if (!globalThis.crypto?.subtle) throw new VaultError("unavailable");
  const hashed = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  vaultActive(signal);
  return Array.from(new Uint8Array(hashed), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Authentication is not content validation; only these three pre-existing contracts are accepted. */
export async function inspectVaultPayload(
  bytes: VaultBytes,
  signal?: AbortSignal,
): Promise<VaultReview> {
  vaultActive(signal);
  vaultSize(bytes.byteLength);
  let documents: VaultDocument[] = [],
    plan: WritingMergePlan | null = null;
  let kind: VaultReview["kind"];
  try {
    const text = vaultDecode(bytes);
    const raw = writingRecord(readCollectionJson(text));
    if (raw?.format === "no-wave-writing-backup") {
      const backup = parseWritingBackup(text);
      documents = [{ id: "d1", group: "w1", backup }];
      kind = "backup";
    } else if (raw?.format === "no-wave-writing-collection") {
      const prepared = await parseWritingCollection(text, signal);
      documents = prepared.collection.entries.map(({ key, group, backup }) => ({
        id: key,
        group,
        backup,
      }));
      kind = "collection";
    } else if (raw?.format === "no-wave-writing-merge-plan") {
      plan = await parseWritingMergePlan(text, signal);
      kind = "merge-plan";
    } else throw new VaultError("payload");
  } catch {
    vaultActive(signal);
    throw new VaultError("payload");
  }
  const digest = await digestVaultBytes(bytes, signal);
  vaultActive(signal);
  return { kind, bytes: bytes.byteLength, digest, documents, plan };
}

/** Equality is exact, including JSON whitespace, BOM, ordering and trailing newlines. */
export function vaultBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let differences = 0;
  for (let index = 0; index < left.length; index++)
    differences |= left[index]! ^ right[index]!;
  return differences === 0;
}

export type VaultVerification = {
  kind: VaultReview["kind"];
  documents: number;
  decisions: number;
  bytes: number;
  digest: string;
};
export function vaultVerification(review: VaultReview): VaultVerification {
  return {
    kind: review.kind,
    documents: review.documents.length,
    decisions: review.plan?.decisions.length ?? 0,
    bytes: review.bytes,
    digest: review.digest,
  };
}
