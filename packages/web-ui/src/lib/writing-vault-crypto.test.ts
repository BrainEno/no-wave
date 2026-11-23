import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { test } from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { createWritingCollection } from "./writing-collection.ts";
import { analyzeWritingMerge } from "./writing-merge.ts";
import { createWritingMergePlan } from "./writing-merge-plan.ts";
import { WritingVaultCryptography } from "./writing-vault-crypto.ts";
import {
  VAULT_FILE_LIMIT,
  VAULT_HEADER_LIMIT,
  VAULT_ITERATIONS,
  encodeVaultAad,
  packVaultEnvelope,
  parseVaultEnvelope,
} from "./writing-vault-format.ts";
import { inspectVaultPayload } from "./writing-vault-payload.ts";

const password = "correct horse 文稿 battery";
const stamp = new Date("2026-11-12T00:00:00.000Z");
const bytes = (text: string) => new TextEncoder().encode(text);
const backup = (text = "PRIVATE_BODY") =>
  createWritingBackup(
    {
      title: "PRIVATE_TITLE",
      summary: "PRIVATE_SUMMARY",
      locale: "zh-CN",
      workType: "other",
      editorState: {
        root: {
          type: "root",
          version: 1,
          children: [
            {
              type: "paragraph",
              version: 1,
              children: [{ type: "text", version: 1, text }],
            },
          ],
        },
      },
    },
    stamp,
  );
const signal = () => new AbortController().signal;
function withSubtle(overrides: Partial<SubtleCrypto>): Crypto {
  const subtle = new Proxy(globalThis.crypto.subtle, {
    get(target, key) {
      const own = Reflect.get(overrides, key) as unknown;
      if (own !== undefined) return own;
      const original: unknown = Reflect.get(target, key, target);
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
  return {
    subtle,
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    randomUUID: globalThis.crypto.randomUUID.bind(globalThis.crypto),
  };
}
function independentlyEncrypt(
  plaintext: Uint8Array,
  secret = password,
): Uint8Array<ArrayBuffer> {
  const salt = Buffer.alloc(32, 17),
    nonce = Buffer.alloc(12, 29);
  const header = bytes(
    JSON.stringify({
      format: "no-wave-writing-vault",
      version: 1,
      cipher: "AES-256-GCM",
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: 600000,
        salt: salt.toString("base64url"),
      },
      nonce: nonce.toString("base64url"),
      plaintextBytes: plaintext.byteLength,
    }),
  );
  const aad = new Uint8Array(12 + header.length);
  aad.set(bytes("NWVAULT\n"));
  new DataView(aad.buffer).setUint32(8, header.length, false);
  aad.set(header, 12);
  const key = pbkdf2Sync(secret, salt, 600000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  key.fill(0);
  const result = new Uint8Array(aad.length + encrypted.length);
  result.set(aad);
  result.set(encrypted, aad.length);
  return result;
}

test("a native AES-GCM/PBKDF2 roundtrip preserves every original UTF-8 byte, BOM and whitespace, and exports no cleartext metadata", async () => {
  const original = bytes(
    "\ufeff  " + backup("中文🙂 <script>PRIVATE_LITERAL</script>") + "\r\n",
  );
  const before = original.slice();
  const crypto = new WritingVaultCryptography();
  const sealed = await crypto.seal(original, password, signal());
  assert.deepEqual(
    original,
    before,
    "the caller's original is not overwritten",
  );
  assert.ok(sealed.bytes.length > original.length);
  assert.equal(sealed.review.kind, "backup");
  assert.equal(sealed.selfChecked, true);
  const header = parseVaultEnvelope(sealed.bytes);
  assert.equal(header.header.kdf.iterations, 600000);
  assert.equal(VAULT_ITERATIONS, 600000);
  const exposed = new TextDecoder().decode(header.aad);
  for (const forbidden of [
    "PRIVATE",
    "title",
    "filename",
    "digest",
    "createdAt",
    "backup",
  ])
    assert.ok(!exposed.includes(forbidden));
  const opened = await crypto.open(sealed.bytes, password, signal());
  assert.deepEqual(opened.bytes, before);
  assert.equal(opened.review.digest, sealed.review.digest);
  assert.equal(opened.review.documents[0]!.backup.draft.title, "PRIVATE_TITLE");
  const second = await crypto.seal(original, password, signal());
  assert.notDeepEqual(
    second.bytes,
    sealed.bytes,
    "fresh salt and nonce even for identical input/password",
  );
});

test("the format interoperates with independent node:crypto, without relying on its own encrypt implementation", async () => {
  const original = bytes(backup());
  const independentlySealed = independentlyEncrypt(original);
  const opened = await new WritingVaultCryptography().open(
    independentlySealed,
    password,
    signal(),
  );
  assert.deepEqual(opened.bytes, original);
  const salt = new Uint8Array(32).fill(17),
    nonce = new Uint8Array(12).fill(29);
  assert.deepEqual(
    encodeVaultAad(original.length, salt, nonce),
    parseVaultEnvelope(independentlySealed).aad,
  );
});

test("wrong passwords, valid-looking authenticated-header changes, ciphertext and tag damage expose the same bounded authentication error", async () => {
  const crypto = new WritingVaultCryptography();
  const sealed = independentlyEncrypt(bytes(backup()));
  async function denied(input: Uint8Array<ArrayBuffer>, secret = password) {
    await assert.rejects(
      crypto.open(input, secret, signal()),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "authentication");
        assert.doesNotMatch(
          String(error),
          /PRIVATE|correct horse|OperationError|DOMException/,
        );
        return true;
      },
    );
  }
  await denied(sealed, "wrong password 文稿 battery");
  const damaged = sealed.slice();
  damaged[damaged.length - 1]! ^= 1;
  await denied(damaged);
  const body = sealed.slice();
  body[body.length - 20]! ^= 1;
  await denied(body);
  const parsed = parseVaultEnvelope(sealed);
  const salt = parsed.salt.slice();
  salt[0]! ^= 1;
  await denied(
    packVaultEnvelope(
      encodeVaultAad(parsed.header.plaintextBytes, salt, parsed.nonce),
      parsed.ciphertext,
    ),
  );
  const nonce = parsed.nonce.slice();
  nonce[0]! ^= 1;
  await denied(
    packVaultEnvelope(
      encodeVaultAad(parsed.header.plaintextBytes, parsed.salt, nonce),
      parsed.ciphertext,
    ),
  );
});

test("unknown, expensive or ambiguous envelope parameters and truncation fail before password derivation", async () => {
  let derives = 0;
  const crypto = new WritingVaultCryptography({
    provider: () =>
      withSubtle({
        deriveKey: async () => {
          derives++;
          throw new Error("must not derive");
        },
      }),
  });
  const original = independentlyEncrypt(bytes(backup()));
  const parsed = parseVaultEnvelope(original);
  const encode = (header: string) => {
    const raw = bytes(header),
      prefix = new Uint8Array(12 + raw.length);
    prefix.set(bytes("NWVAULT\n"));
    new DataView(prefix.buffer).setUint32(8, raw.length);
    prefix.set(raw, 12);
    return packVaultEnvelope(prefix, parsed.ciphertext);
  };
  const header = JSON.stringify(parsed.header);
  for (const invalid of [
    header.replace("600000", "999999999"),
    header.replace("600000", "1000"),
    header.replace('"version":1', '"version":2'),
    header.replace('"version":1', '"version":2,"ver\\u0073ion":1'),
    header.replace('"cipher":"AES-256-GCM"', '"cipher":"AES-CBC"'),
    header.replace('"name":"PBKDF2"', '"name":"scrypt"'),
    header.replace('"hash":"SHA-256"', '"hash":"SHA-1"'),
    header.replace('"format":', '"unknown":0,"format":'),
    header.replace('"format":', '"__proto__":{},"format":'),
    header.replace(parsed.header.kdf.salt, parsed.header.kdf.salt + "="),
  ])
    await assert.rejects(crypto.open(encode(invalid), password, signal()));
  for (const invalid of [
    original.slice(0, -1),
    original.slice(0, 8),
    new Uint8Array(VAULT_FILE_LIMIT + 1),
  ]) {
    await assert.rejects(crypto.open(invalid, password, signal()));
  }
  const deep = original.slice();
  new DataView(deep.buffer).setUint32(8, VAULT_HEADER_LIMIT + 1);
  await assert.rejects(crypto.open(deep, password, signal()));
  assert.equal(derives, 0);
});

test("authenticated plaintext still has to satisfy the existing strict backup/collection/plan contracts", async () => {
  const crypto = new WritingVaultCryptography();
  for (const invalid of [
    "{}",
    backup().replace('"version": 1', '"version": 9, "ver\\u0073ion": 1'),
    backup().replace('"title":', '"actor":"forged","title":'),
  ]) {
    await assert.rejects(crypto.seal(bytes(invalid), password, signal()));
    await assert.rejects(
      crypto.open(independentlyEncrypt(bytes(invalid)), password, signal()),
      (e: unknown) => (e as { code: string }).code === "payload",
    );
  }
  await assert.rejects(
    crypto.open(
      independentlyEncrypt(new Uint8Array([0xc3, 0x28])),
      password,
      signal(),
    ),
  );
  const one = parseWritingBackup(backup());
  const collection = await createWritingCollection(
    [{ group: "one", backup: one }],
    stamp,
  );
  const sources = await analyzeWritingMerge({
    base: one,
    current: one,
    incoming: one,
  });
  const plan = await createWritingMergePlan(sources, [], stamp);
  for (const [text, kind] of [
    [collection.text, "collection"],
    [plan.text, "merge-plan"],
  ] as const) {
    const sealed = await crypto.seal(bytes(text), password, signal());
    const opened = await crypto.open(sealed.bytes, password, signal());
    assert.equal(opened.review.kind, kind);
    assert.deepEqual(opened.bytes, bytes(text));
  }
});

test("passwords use exact Unicode and spaces, reject malformed/short input, and never downgrade absent Web Crypto", async () => {
  const crypto = new WritingVaultCryptography(),
    original = bytes(backup());
  for (const secret of [
    "short",
    " ".repeat(20),
    "x".repeat(257),
    "valid length\ud800broken",
    "valid length\u0000broken",
  ]) {
    await assert.rejects(
      crypto.seal(original, secret, signal()),
      (e: unknown) => (e as { code: string }).code === "password",
    );
  }
  const exact = "  e\u0301 密码 exact spaces  ";
  const sealed = await crypto.seal(original, exact, signal());
  await assert.rejects(
    crypto.open(sealed.bytes, exact.trim(), signal()),
    (e: unknown) => (e as { code: string }).code === "authentication",
  );
  await assert.rejects(
    crypto.open(sealed.bytes, exact.normalize("NFC"), signal()),
    (e: unknown) => (e as { code: string }).code === "authentication",
  );
  const unavailable = new WritingVaultCryptography({
    provider: () => {
      throw new Error("private native reason");
    },
  });
  await assert.rejects(
    unavailable.seal(original, password, signal()),
    (e: unknown) => {
      assert.equal((e as { code: string }).code, "unavailable");
      assert.doesNotMatch(String(e), /private native/);
      return true;
    },
  );
});

test("cancelled unabortable KDF work keeps the single-flight slot occupied and cannot publish or begin encryption", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let encrypts = 0,
    entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = withSubtle({
    deriveKey: async (...args: Parameters<SubtleCrypto["deriveKey"]>) => {
      entered();
      await pending;
      return globalThis.crypto.subtle.deriveKey(...args);
    },
    encrypt: async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
      encrypts++;
      return globalThis.crypto.subtle.encrypt(...args);
    },
  });
  const crypto = new WritingVaultCryptography({ provider: () => provider });
  const abort = new AbortController();
  const first = crypto.seal(bytes(backup()), password, abort.signal);
  await reached;
  abort.abort();
  assert.equal(crypto.getSnapshot(), true);
  await assert.rejects(
    crypto.seal(bytes(backup()), password, signal()),
    (e: unknown) => (e as { code: string }).code === "busy",
  );
  release();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(encrypts, 0);
  assert.equal(crypto.getSnapshot(), false);
});

test("synchronous cancellation on the running signal, or native failures, leave no permanently busy slot", async () => {
  const abort = new AbortController(),
    crypto = new WritingVaultCryptography();
  const unsubscribe = crypto.subscribe(() => {
    if (crypto.getSnapshot()) abort.abort();
  });
  await assert.rejects(crypto.seal(bytes(backup()), password, abort.signal), {
    name: "AbortError",
  });
  assert.equal(crypto.getSnapshot(), false);
  unsubscribe();
  const bad = new WritingVaultCryptography({
    provider: () =>
      withSubtle({
        encrypt: async () => {
          throw new Error("PRIVATE_NATIVE");
        },
      }),
  });
  await assert.rejects(
    bad.seal(bytes(backup()), password, signal()),
    (e: unknown) => {
      assert.doesNotMatch(String(e), /PRIVATE_NATIVE/);
      return true;
    },
  );
  assert.equal(bad.getSnapshot(), false);
});

test("self-check failure cannot yield a downloadable encrypted result, and sensitive temporary byte views are wiped", async () => {
  let supplied: Uint8Array<ArrayBuffer> | null = null;
  const crypto = new WritingVaultCryptography({
    provider: () =>
      withSubtle({
        decrypt: async () => {
          supplied = bytes("PRIVATE_WRONG_PLAINTEXT");
          return supplied.buffer;
        },
      }),
  });
  await assert.rejects(
    crypto.seal(bytes(backup()), password, signal()),
    (e: unknown) => (e as { code: string }).code === "self-check",
  );
  assert.ok(supplied);
  assert.ok(Array.from(supplied as Uint8Array).every((byte) => byte === 0));
});

test("the payload digest is over exact input bytes, not canonical JSON or normalized editor semantics", async () => {
  const one = bytes(backup()),
    two = bytes(" " + backup());
  const left = await inspectVaultPayload(one, signal()),
    right = await inspectVaultPayload(two, signal());
  assert.notEqual(left.digest, right.digest);
  assert.equal(left.bytes + 1, right.bytes);
});

test("manual password rotation never requires a plaintext file and leaves the original encrypted bytes usable only with the original password", async () => {
  const crypto = new WritingVaultCryptography(),
    original = bytes(backup());
  const encrypted = await crypto.seal(original, password, signal());
  const before = encrypted.bytes.slice(),
    replacement = "new independent 文稿 passphrase";
  const rotated = await crypto.rotate(
    encrypted.bytes,
    password,
    replacement,
    signal(),
  );
  assert.deepEqual(encrypted.bytes, before);
  assert.notDeepEqual(rotated.bytes, encrypted.bytes);
  assert.deepEqual(
    (await crypto.open(rotated.bytes, replacement, signal())).bytes,
    original,
  );
  await assert.rejects(
    crypto.open(rotated.bytes, password, signal()),
    (error: unknown) => (error as { code: string }).code === "authentication",
  );
  assert.deepEqual(
    (await crypto.open(encrypted.bytes, password, signal())).bytes,
    original,
  );
  await assert.rejects(
    crypto.rotate(encrypted.bytes, password, password, signal()),
  );
});

test("rotation holds one native slot across both password derivations and rejects a canceled second stage without yielding plaintext", async () => {
  const encrypted = independentlyEncrypt(bytes(backup()));
  let encrypts = 0;
  const abort = new AbortController();
  const crypto = new WritingVaultCryptography({
    provider: () =>
      withSubtle({
        encrypt: async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
          encrypts++;
          return globalThis.crypto.subtle.encrypt(...args);
        },
      }),
  });
  let validations = 0;
  await assert.rejects(
    crypto.rotate(
      encrypted,
      password,
      "new independent 文稿 passphrase",
      abort.signal,
      (stage) => {
        assert.equal(crypto.getSnapshot(), true);
        if (stage === "validating" && ++validations === 2) abort.abort();
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(encrypts, 0);
  assert.equal(crypto.getSnapshot(), false);
});
