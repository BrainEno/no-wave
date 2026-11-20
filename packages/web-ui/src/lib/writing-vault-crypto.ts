import {
  encodeVaultAad,
  packVaultEnvelope,
  parseVaultEnvelope,
  VAULT_ITERATIONS,
  VAULT_FILE_LIMIT,
  VaultError,
  vaultActive,
  vaultFailure,
  vaultSize,
  type VaultBytes,
} from "./writing-vault-format.ts";
import {
  inspectVaultPayload,
  vaultVerification,
  type VaultVerification,
  vaultBytesEqual,
  type VaultReview,
} from "./writing-vault-payload.ts";

export type VaultCryptoStage =
  "validating" | "deriving" | "encrypting" | "self-checking" | "decrypting";
export type VaultOpened = { bytes: VaultBytes; review: VaultReview };
export type VaultSealed = VaultOpened & { selfChecked: true };
type CryptoOptions = { provider?: () => Crypto };
type Stage = (stage: VaultCryptoStage) => void;

export function validateVaultPassword(password: string): void {
  if (
    typeof password !== "string" ||
    password.length > 512 ||
    /[\u0000-\u001f\u007f\p{Cs}]/u.test(password) ||
    !password.trim()
  )
    throw new VaultError("password");
  const characters = Array.from(password).length;
  if (characters < 12 || characters > 256) throw new VaultError("password");
}

/** Single-flight, zero-queue. Aborting an intent does NOT free an unabortable native KDF. */
export class WritingVaultCryptography {
  private busy = false;
  private listeners = new Set<() => void>();
  private provider: () => Crypto;
  constructor(options: CryptoOptions = {}) {
    this.provider = options.provider ?? (() => globalThis.crypto);
  }
  getSnapshot = (): boolean => this.busy;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  private crypto(): Crypto {
    try {
      const crypto = this.provider();
      if (!crypto?.subtle || typeof crypto.getRandomValues !== "function")
        throw new VaultError("unavailable");
      return crypto;
    } catch {
      throw new VaultError("unavailable");
    }
  }
  private async exclusive<T extends VaultOpened>(
    signal: AbortSignal,
    operation: (crypto: Crypto) => Promise<T>,
  ): Promise<T> {
    vaultActive(signal);
    if (this.busy) throw new VaultError("busy");
    this.busy = true;
    try {
      // Establish the fence before publishing busy: subscribers may cancel synchronously.
      this.notify();
      vaultActive(signal);
      const result = await operation(this.crypto());
      if (signal.aborted) {
        result.bytes.fill(0);
        vaultActive(signal);
      }
      return result;
    } catch (error) {
      vaultActive(signal);
      throw vaultFailure(error);
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  private async key(
    crypto: Crypto,
    password: string,
    salt: VaultBytes,
    signal: AbortSignal,
  ): Promise<CryptoKey> {
    validateVaultPassword(password);
    vaultActive(signal);
    const secret = new TextEncoder().encode(password);
    try {
      const material = await crypto.subtle.importKey(
        "raw",
        secret,
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      vaultActive(signal);
      const key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", iterations: VAULT_ITERATIONS, salt },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      vaultActive(signal);
      return key;
    } finally {
      secret.fill(0);
    }
  }
  async inspect(
    input: VaultBytes,
    signal: AbortSignal,
    progress: Stage = () => {},
  ): Promise<VaultOpened> {
    return this.exclusive(signal, async () => {
      vaultSize(input.byteLength);
      const bytes = input.slice();
      try {
        progress("validating");
        vaultActive(signal);
        return { bytes, review: await inspectVaultPayload(bytes, signal) };
      } catch (error) {
        bytes.fill(0);
        throw error;
      }
    });
  }
  async seal(
    input: VaultBytes,
    password: string,
    signal: AbortSignal,
    progress: Stage = () => {},
  ): Promise<VaultSealed> {
    return this.exclusive(signal, (crypto) =>
      this.sealWithin(crypto, input, password, signal, progress),
    );
  }
  async open(
    input: VaultBytes,
    password: string,
    signal: AbortSignal,
    progress: Stage = () => {},
  ): Promise<VaultOpened> {
    return this.exclusive(signal, (crypto) =>
      this.openWithin(crypto, input, password, signal, progress),
    );
  }
  async verify(
    input: VaultBytes,
    password: string,
    signal: AbortSignal,
    progress: Stage = () => {},
  ): Promise<VaultVerification> {
    const opened = await this.open(input, password, signal, progress);
    try {
      vaultActive(signal);
      return vaultVerification(opened.review);
    } finally {
      opened.bytes.fill(0);
    }
  }
  async rotate(
    input: VaultBytes,
    password: string,
    replacement: string,
    signal: AbortSignal,
    progress: Stage = () => {},
  ): Promise<VaultSealed> {
    return this.exclusive(signal, async (crypto) => {
      validateVaultPassword(password);
      validateVaultPassword(replacement);
      if (password === replacement) throw new VaultError("confirmation");
      // The original is authenticated and validated before any new ciphertext exists.
      const opened = await this.openWithin(
        crypto,
        input,
        password,
        signal,
        progress,
      );
      try {
        vaultActive(signal);
        return await this.sealWithin(
          crypto,
          opened.bytes,
          replacement,
          signal,
          progress,
        );
      } finally {
        opened.bytes.fill(0);
      }
    });
  }
  private async sealWithin(
    crypto: Crypto,
    input: VaultBytes,
    password: string,
    signal: AbortSignal,
    progress: Stage,
  ): Promise<VaultSealed> {
    vaultSize(input.byteLength);
    validateVaultPassword(password);
    // Own one detached copy: callers may clear/replace their source during native awaits.
    const plaintext = input.slice();
    let verification: VaultBytes | null = null,
      encrypted: VaultBytes | null = null;
    try {
      progress("validating");
      vaultActive(signal);
      const review = await inspectVaultPayload(plaintext, signal);
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const aad = encodeVaultAad(plaintext.length, salt, nonce);
      progress("deriving");
      vaultActive(signal);
      const key = await this.key(crypto, password, salt, signal);
      progress("encrypting");
      vaultActive(signal);
      encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
          key,
          plaintext,
        ),
      );
      vaultActive(signal);
      const bytes = packVaultEnvelope(aad, encrypted);
      const parsed = parseVaultEnvelope(bytes);
      progress("self-checking");
      vaultActive(signal);
      // Decrypt the actual serialized artifact, not a parallel in-memory approximation.
      verification = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: parsed.nonce,
            additionalData: parsed.aad,
            tagLength: 128,
          },
          key,
          parsed.ciphertext,
        ),
      );
      vaultActive(signal);
      if (!vaultBytesEqual(plaintext, verification))
        throw new VaultError("self-check");
      return { bytes, review, selfChecked: true };
    } finally {
      plaintext.fill(0);
      verification?.fill(0);
      encrypted?.fill(0);
    }
  }
  private async openWithin(
    crypto: Crypto,
    input: VaultBytes,
    password: string,
    signal: AbortSignal,
    progress: Stage,
  ): Promise<VaultOpened> {
    vaultSize(input.byteLength, VAULT_FILE_LIMIT);
    const envelope = input.slice();
    let plaintext: VaultBytes | null = null;
    let transferred = false;
    try {
      const parsed = parseVaultEnvelope(envelope);
      validateVaultPassword(password);
      progress("deriving");
      vaultActive(signal);
      const key = await this.key(crypto, password, parsed.salt, signal);
      progress("decrypting");
      vaultActive(signal);
      try {
        plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: parsed.nonce,
              additionalData: parsed.aad,
              tagLength: 128,
            },
            key,
            parsed.ciphertext,
          ),
        );
      } catch {
        vaultActive(signal);
        throw new VaultError("authentication");
      }
      vaultActive(signal);
      if (plaintext.length !== parsed.header.plaintextBytes)
        throw new VaultError("authentication");
      progress("validating");
      vaultActive(signal);
      const review = await inspectVaultPayload(plaintext, signal);
      vaultActive(signal);
      transferred = true;
      return { bytes: plaintext, review };
    } finally {
      envelope.fill(0);
      if (!transferred) plaintext?.fill(0);
    }
  }
}

// Shared across route remounts: navigating away cannot create concurrent KDF workers.
export const writingVaultCryptography = new WritingVaultCryptography();
