import {
  VaultError,
  vaultActive,
  vaultDecode,
  vaultSize,
  type VaultBytes,
} from "./writing-vault-format.ts";

export type VaultTextPage = { start: number; end: number; text: string };
export type VaultTextSearch = {
  hits: { start: number; end: number }[];
  complete: boolean;
  scannedBytes: number;
};
const PAGE_BYTES = 8192;
function offset(bytes: VaultBytes, value: number): void {
  vaultSize(bytes.byteLength);
  if (!Number.isSafeInteger(value) || value < 0 || value > bytes.length)
    throw new VaultError("stale");
}
function continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** Bounded exact slices, never a full-file DOM string; byte offsets are not character positions. */
export function vaultTextPage(
  bytes: VaultBytes,
  anchor: number,
  direction: "forward" | "backward" = "forward",
): VaultTextPage {
  offset(bytes, anchor);
  if (direction !== "forward" && direction !== "backward")
    throw new VaultError("stale");
  let start: number, end: number;
  if ((direction === "backward" && anchor > 0) || anchor === bytes.length) {
    end = anchor;
    for (let count = 0; continuation(bytes[end]) && count < 3; count++) end--;
    start = Math.max(0, end - PAGE_BYTES);
    for (let count = 0; continuation(bytes[start]) && count < 3; count++)
      start++;
  } else {
    start = anchor;
    for (let count = 0; continuation(bytes[start]) && count < 3; count++)
      start--;
    end = Math.min(bytes.length, start + PAGE_BYTES);
    for (let count = 0; continuation(bytes[end]) && count < 3; count++) end--;
  }
  if (
    start < 0 ||
    end <= start ||
    end - start > PAGE_BYTES ||
    continuation(bytes[start]) ||
    continuation(bytes[end])
  )
    throw new VaultError("payload");
  return { start, end, text: vaultDecode(bytes.subarray(start, end)) };
}

/** Linear byte KMP avoids quadratic repeated-prefix input; at most 100 content-free offsets, no regex or persistent index. */
export async function searchVaultText(
  bytes: VaultBytes,
  query: string,
  from: number,
  signal: AbortSignal,
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<VaultTextSearch> {
  vaultActive(signal);
  offset(bytes, from);
  if (
    typeof query !== "string" ||
    !query ||
    query.length > 240 ||
    Array.from(query).length > 120 ||
    /[\p{Cs}\u0000]/u.test(query)
  )
    throw new VaultError("stale");
  const needle = new TextEncoder().encode(query),
    owned = bytes.slice();
  const table = new Uint16Array(needle.length);
  const hits: VaultTextSearch["hits"] = [];
  try {
    for (let index = 1, matched = 0; index < needle.length; index++) {
      while (matched && needle[index] !== needle[matched])
        matched = table[matched - 1]!;
      if (needle[index] === needle[matched]) matched++;
      table[index] = matched;
    }
    let matched = 0;
    for (let index = from; index < owned.length; index++) {
      if ((index - from) % 65536 === 0) {
        vaultActive(signal);
        await pause();
        vaultActive(signal);
      }
      while (matched && owned[index] !== needle[matched])
        matched = table[matched - 1]!;
      if (owned[index] === needle[matched]) matched++;
      if (matched !== needle.length) continue;
      hits.push({ start: index + 1 - matched, end: index + 1 });
      matched = table[matched - 1]!;
      if (hits.length === 100)
        return {
          hits,
          complete: index + 1 === owned.length,
          scannedBytes: index + 1 - from,
        };
    }
    vaultActive(signal);
    return { hits, complete: true, scannedBytes: owned.length - from };
  } finally {
    owned.fill(0);
    needle.fill(0);
    table.fill(0);
  }
}
