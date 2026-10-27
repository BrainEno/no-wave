import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP's scrypt fallback configuration: N=2^15, r=8, p=3 (~32 MiB
// per calculation). A random salt is unique per account; no plaintext or
// reversible password representation is stored.
const N = 32768;
const R = 8;
const P = 3;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x73);
const DUMMY_HASH = Buffer.alloc(KEY_BYTES, 0);

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** Unknown users and malformed stored hashes still incur the same KDF cost. */
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  let salt = DUMMY_SALT;
  let expected = DUMMY_HASH;
  let validFormat = false;
  if (typeof encoded === "string") {
    const parts = encoded.split("$");
    if (parts.length === 6 && parts[0] === "scrypt" && parts[1] === String(N) && parts[2] === String(R) && parts[3] === String(P) &&
        /^[A-Za-z0-9_-]+$/.test(parts[4]) && /^[A-Za-z0-9_-]+$/.test(parts[5])) {
      const candidateSalt = Buffer.from(parts[4], "base64url");
      const candidateHash = Buffer.from(parts[5], "base64url");
      if (candidateSalt.length === SALT_BYTES && candidateHash.length === KEY_BYTES &&
          candidateSalt.toString("base64url") === parts[4] && candidateHash.toString("base64url") === parts[5]) {
        salt = candidateSalt;
        expected = candidateHash;
        validFormat = true;
      }
    }
  }
  const actual = await derive(password, salt);
  const equal = timingSafeEqual(actual, expected);
  return validFormat && equal;
}
