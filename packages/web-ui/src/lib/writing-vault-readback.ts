import {
  VAULT_FILE_LIMIT,
  vaultActive,
  vaultSize,
  type VaultBytes,
} from "./writing-vault-format.ts";
import { digestVaultBytes } from "./writing-vault-payload.ts";

export type VaultReadback = {
  matches: boolean;
  reason: "identical" | "truncated" | "appended" | "modified";
  expectedBytes: number;
  actualBytes: number;
  differentBytes: number;
  firstDifference: number | null;
  expectedDigest: string;
  actualDigest: string;
};

/** Content-free readback of an explicitly selected saved file; names/JSON semantics prove nothing. */
export async function compareVaultReadback(
  expected: VaultBytes,
  actual: VaultBytes,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<VaultReadback> {
  vaultActive(signal);
  vaultSize(expected.byteLength, VAULT_FILE_LIMIT);
  vaultSize(actual.byteLength, VAULT_FILE_LIMIT);
  const left = expected.slice(),
    right = actual.slice();
  try {
    const common = Math.min(left.length, right.length);
    let changed = 0,
      firstDifference: number | null = null;
    for (let start = 0; start < common; start += 262144) {
      vaultActive(signal);
      const end = Math.min(common, start + 262144);
      for (let offset = start; offset < end; offset++) {
        if (left[offset] !== right[offset]) {
          changed++;
          if (firstDifference === null) firstDifference = offset;
        }
      }
      progress(Math.floor((end / common) * 100));
      vaultActive(signal);
      await pause();
    }
    const missing = Math.abs(left.length - right.length);
    if (missing && firstDifference === null) firstDifference = common;
    const reason = changed
      ? "modified"
      : missing
        ? left.length > right.length
          ? "truncated"
          : "appended"
        : "identical";
    const expectedDigest = await digestVaultBytes(left, signal);
    const actualDigest = await digestVaultBytes(right, signal);
    vaultActive(signal);
    return {
      matches: changed + missing === 0,
      reason,
      expectedBytes: left.length,
      actualBytes: right.length,
      differentBytes: changed + missing,
      firstDifference,
      expectedDigest,
      actualDigest,
    };
  } finally {
    left.fill(0);
    right.fill(0);
  }
}
