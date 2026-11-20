import { readLocalFileBytes } from "./writing-collection-browser.ts";
import { COLLECTION_BYTE_LIMIT } from "./writing-collection.ts";
import {
  isVaultEnvelope,
  parseVaultEnvelope,
  parseVaultPreamble,
  vaultPrefixSize,
  VAULT_FILE_LIMIT,
  VaultError,
  vaultActive,
  vaultSize,
  type VaultBytes,
} from "./writing-vault-format.ts";

type Reader = (
  blob: Blob,
  signal: AbortSignal,
  progress: (percent: number) => void,
) => Promise<VaultBytes>;
/** A selected Blob is the only input. Reject hostile envelope parameters using <=1036 bytes before reading ciphertext. */
export async function readVaultLocalFile(
  file: Blob,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
  read: Reader = (blob, signal, progress) =>
    readLocalFileBytes(blob, signal, progress, undefined, VAULT_FILE_LIMIT),
): Promise<VaultBytes> {
  vaultActive(signal);
  vaultSize(file.size, VAULT_FILE_LIMIT);
  const size = file.size;
  let prefix: VaultBytes | null = null,
    header: VaultBytes | null = null,
    aad: VaultBytes | null = null,
    complete: VaultBytes | null = null;
  let returned = false;
  async function piece(
    blob: Blob,
    report: (percent: number) => void,
  ): Promise<VaultBytes> {
    let bytes: VaultBytes | null = null;
    try {
      vaultActive(signal);
      bytes = await read(blob, signal, (value) => {
        vaultActive(signal);
        if (Number.isFinite(value)) report(Math.max(0, Math.min(100, value)));
      });
      vaultActive(signal);
      if (bytes.byteLength !== blob.size) throw new VaultError("read");
      return bytes;
    } catch (error) {
      bytes?.fill(0);
      vaultActive(signal);
      throw error instanceof VaultError ? error : new VaultError("read");
    }
  }
  try {
    prefix = await piece(file.slice(0, Math.min(12, size)), () => {});
    const locked = isVaultEnvelope(prefix);
    if (locked) {
      const bytes = vaultPrefixSize(prefix, size);
      header = await piece(file.slice(12, bytes), () => {});
      aad = new Uint8Array(bytes);
      aad.set(prefix);
      aad.set(header, 12);
      parseVaultPreamble(aad, size);
    } else vaultSize(size, COLLECTION_BYTE_LIMIT);
    vaultActive(signal);
    progress(0);
    vaultActive(signal);
    complete = await piece(file, progress);
    if (file.size !== size) throw new VaultError("read");
    const expected = aad ?? prefix;
    let differences = 0;
    for (let index = 0; index < expected.length; index++)
      differences |= expected[index]! ^ complete[index]!;
    if (differences) throw new VaultError("read");
    if (locked) parseVaultEnvelope(complete);
    vaultActive(signal);
    returned = true;
    return complete;
  } finally {
    prefix?.fill(0);
    header?.fill(0);
    aad?.fill(0);
    if (!returned) complete?.fill(0);
  }
}
