import { WritingVaultCryptography } from "./writing-vault-crypto.ts";
import {
  installVaultWorker,
  type VaultWorkerScope,
} from "./writing-vault-worker-protocol.ts";

// This module is only a dedicated-Worker entry, never an SSR/window entry. The
// port contract deliberately avoids merging conflicting DOM/WebWorker globals.
installVaultWorker(
  globalThis as unknown as VaultWorkerScope,
  new WritingVaultCryptography(),
);
