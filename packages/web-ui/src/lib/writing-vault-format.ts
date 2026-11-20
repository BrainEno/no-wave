import {
  COLLECTION_BYTE_LIMIT,
  readCollectionJson,
} from "./writing-collection.ts";
import { writingRecord } from "./writing-document.ts";

export type VaultBytes = Uint8Array<ArrayBuffer>;
export const VAULT_HEADER_LIMIT = 1024;
export const VAULT_ITERATIONS = 600000;
export const VAULT_FILE_LIMIT =
  COLLECTION_BYTE_LIMIT + 12 + VAULT_HEADER_LIMIT + 16;
const MAGIC = new TextEncoder().encode("NWVAULT\n");

export type VaultFailureCode =
  | "format"
  | "size"
  | "password"
  | "payload"
  | "authentication"
  | "unavailable"
  | "busy"
  | "crypto"
  | "self-check"
  | "stale"
  | "read"
  | "consent"
  | "confirmation"
  | "worker";
const MESSAGES: Record<VaultFailureCode, string> = {
  format:
    "不是支持的加密文稿 v1，或文件头、参数、完整长度无效。没有启动密码计算。",
  size: "本机文件为空或超限；明文最多 16 MiB，密文只允许固定的少量封装开销。",
  password:
    "请输入 12–256 个 Unicode 字符的口令，不支持控制字符、损坏字符或全空白。不会修剪空格或正规化文字。",
  payload:
    "文件未通过现有单篇备份、集合或三方取舍计划的严格校验；没有输出任何明文。",
  authentication:
    "口令不匹配，或加密文件被修改、损坏。认证失败，没有输出任何明文。",
  unavailable:
    "需要支持原生 Web Crypto 的安全浏览器页面；没有降级为明文或弱加密。",
  busy: "上一项本机密码计算尚未结束。原生计算不能强行中止，请稍后手动重试；不会排队重放。",
  crypto: "本机加密操作失败，没有生成可下载结果；原始文件未改变。",
  "self-check": "加密副本回解后的字节与原稿不一致，没有提供下载。请保留原稿。",
  stale: "来源、密码、确认或操作已变化，旧结果不能使用，请重新准备。",
  consent:
    "请先确认口令丢失不可恢复、原稿不变和本机使用风险，再手动准备加密副本。",
  worker:
    "专用工作线程不可用、超时或通信失败。没有回退到主线程、自动重启或重放；请保留原稿，重新加载页面后再手动尝试。",
  confirmation:
    "两次输入的新口令必须完全一致，换口令时还须与原口令不同；空格和 Unicode 组合形式也必须匹配。",
  read: "本机文件读取失败或字节数已变化；没有接纳截断或部分内容。",
};

/** Only fixed, payload-free diagnostics may cross the model/UI failure boundary. */
export class VaultError extends Error {
  readonly code: VaultFailureCode;
  constructor(code: VaultFailureCode) {
    super(MESSAGES[code]);
    this.name = "VaultError";
    this.code = code;
  }
}
export function vaultActive(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("本机加密文稿操作已取消。", "AbortError");
}
export function vaultFailure(error: unknown): VaultError {
  return error instanceof VaultError ? error : new VaultError("crypto");
}
export function vaultSize(size: number, limit = COLLECTION_BYTE_LIMIT): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > limit)
    throw new VaultError("size");
}
export function vaultDecode(bytes: Uint8Array): string {
  try {
    // Keep an initial BOM as U+FEFF: encoding this string again must preserve it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new VaultError("payload");
  }
}
export function vaultBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function fixedBase64(value: unknown, length: number): VaultBytes {
  if (
    typeof value !== "string" ||
    value.length !== Math.ceil((length * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new VaultError("format");
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    throw new VaultError("format");
  }
  const decoded = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (decoded.length !== length || vaultBase64(decoded) !== value)
    throw new VaultError("format");
  return decoded;
}
function exactHeader(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const record = writingRecord(value);
  if (
    !record ||
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new VaultError("format");
  return record;
}
export type VaultHeader = {
  format: "no-wave-writing-vault";
  version: 1;
  cipher: "AES-256-GCM";
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: typeof VAULT_ITERATIONS;
    salt: string;
  };
  nonce: string;
  plaintextBytes: number;
};
export type ParsedVaultEnvelope = {
  header: VaultHeader;
  salt: VaultBytes;
  nonce: VaultBytes;
  aad: VaultBytes;
  ciphertext: VaultBytes;
};

/** The raw prefix AND header bytes are GCM AAD; parsing never canonicalizes them. */
export function encodeVaultAad(
  plaintextBytes: number,
  salt: Uint8Array,
  nonce: Uint8Array,
): VaultBytes {
  vaultSize(plaintextBytes);
  if (salt.length !== 32 || nonce.length !== 12) throw new VaultError("format");
  const header: VaultHeader = {
    format: "no-wave-writing-vault",
    version: 1,
    cipher: "AES-256-GCM",
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: VAULT_ITERATIONS,
      salt: vaultBase64(salt),
    },
    nonce: vaultBase64(nonce),
    plaintextBytes,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  if (encoded.length > VAULT_HEADER_LIMIT) throw new VaultError("format");
  const aad = new Uint8Array(12 + encoded.length);
  aad.set(MAGIC);
  new DataView(aad.buffer).setUint32(8, encoded.length, false);
  aad.set(encoded, 12);
  return aad;
}
export function packVaultEnvelope(
  aad: Uint8Array,
  ciphertext: Uint8Array,
): VaultBytes {
  if (
    aad.length < 13 ||
    aad.length > 12 + VAULT_HEADER_LIMIT ||
    ciphertext.length < 17 ||
    ciphertext.length > COLLECTION_BYTE_LIMIT + 16
  )
    throw new VaultError("format");
  const packed = new Uint8Array(aad.length + ciphertext.length);
  packed.set(aad);
  packed.set(ciphertext, aad.length);
  return packed;
}
export function isVaultEnvelope(bytes: Uint8Array): boolean {
  return (
    bytes.length >= MAGIC.length &&
    MAGIC.every((byte, index) => bytes[index] === byte)
  );
}
export function vaultPrefixSize(bytes: VaultBytes, totalBytes: number): number {
  vaultSize(totalBytes, VAULT_FILE_LIMIT);
  if (bytes.length < 12 || !isVaultEnvelope(bytes))
    throw new VaultError("format");
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(8, false);
  if (
    length < 1 ||
    length > VAULT_HEADER_LIMIT ||
    totalBytes < 12 + length + 17
  )
    throw new VaultError("format");
  return 12 + length;
}
export function parseVaultPreamble(
  bytes: VaultBytes,
  totalBytes: number,
): Omit<ParsedVaultEnvelope, "ciphertext"> {
  const length = vaultPrefixSize(bytes, totalBytes);
  if (bytes.length !== length) throw new VaultError("format");
  const aad = bytes;
  let decoded: unknown;
  try {
    decoded = readCollectionJson(vaultDecode(aad.subarray(12)));
  } catch {
    throw new VaultError("format");
  }
  const header = exactHeader(decoded, [
    "format",
    "version",
    "cipher",
    "kdf",
    "nonce",
    "plaintextBytes",
  ]);
  const kdf = exactHeader(header.kdf, ["name", "hash", "iterations", "salt"]);
  if (
    header.format !== "no-wave-writing-vault" ||
    header.version !== 1 ||
    header.cipher !== "AES-256-GCM" ||
    kdf.name !== "PBKDF2" ||
    kdf.hash !== "SHA-256" ||
    kdf.iterations !== VAULT_ITERATIONS ||
    typeof header.plaintextBytes !== "number" ||
    !Number.isSafeInteger(header.plaintextBytes) ||
    header.plaintextBytes < 1 ||
    header.plaintextBytes > COLLECTION_BYTE_LIMIT ||
    totalBytes !== aad.length + header.plaintextBytes + 16
  )
    throw new VaultError("format");
  const salt = fixedBase64(kdf.salt, 32),
    nonce = fixedBase64(header.nonce, 12);
  return {
    header: {
      format: "no-wave-writing-vault",
      version: 1,
      cipher: "AES-256-GCM",
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: VAULT_ITERATIONS,
        salt: kdf.salt as string,
      },
      nonce: header.nonce as string,
      plaintextBytes: header.plaintextBytes,
    },
    salt,
    nonce,
    aad,
  };
}

export function parseVaultEnvelope(bytes: VaultBytes): ParsedVaultEnvelope {
  const size = vaultPrefixSize(bytes, bytes.byteLength);
  const preamble = parseVaultPreamble(
    bytes.subarray(0, size),
    bytes.byteLength,
  );
  return { ...preamble, ciphertext: bytes.subarray(size) };
}
