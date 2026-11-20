import assert from "node:assert/strict";
import { test } from "node:test";
import { createWritingBackup } from "./writing-backup.ts";
import { WritingVaultCryptography } from "./writing-vault-crypto.ts";
import { readVaultLocalFile } from "./writing-vault-local-file.ts";
const password = "fixture preflight 文稿 password";
const plain = new TextEncoder().encode(
  "\ufeff " +
    createWritingBackup(
      {
        title: "PRIVATE_FILE",
        summary: "",
        locale: "en",
        workType: "essay",
        editorState: {
          root: {
            type: "root",
            version: 1,
            children: [{ type: "paragraph", version: 1, children: [] }],
          },
        },
      },
      new Date("2026-11-12T00:00:00.000Z"),
    ) +
    "\r\n",
);
const signal = () => new AbortController().signal;
const read = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

test("local preflight reads only a fixed prefix and bounded header before accepting any complete encrypted payload", async () => {
  const locked = await new WritingVaultCryptography().seal(
    plain,
    password,
    signal(),
  );
  const sizes: number[] = [];
  const bytes = await readVaultLocalFile(
    new Blob([locked.bytes]),
    signal(),
    () => {},
    async (blob) => {
      sizes.push(blob.size);
      return read(blob);
    },
  );
  assert.deepEqual(bytes, locked.bytes);
  assert.equal(sizes.length, 3);
  assert.equal(sizes[0], 12);
  assert.ok(sizes[1]! <= 1024);
  assert.equal(sizes[2], locked.bytes.length);
  assert.deepEqual(
    await readVaultLocalFile(new Blob([plain]), signal(), () => {}, read),
    plain,
  );
});

test("illegal parameters, header length, excess bytes and truncation are rejected before reading the whole ciphertext", async () => {
  const locked = (
    await new WritingVaultCryptography().seal(plain, password, signal())
  ).bytes;
  const illegal = Buffer.from(locked),
    header = illegal.subarray(12, 12 + illegal.readUInt32BE(8));
  Buffer.from("999999").copy(
    illegal,
    12 + header.indexOf(Buffer.from("600000")),
  );
  const hugeHeader = Buffer.from(locked);
  hugeHeader.writeUInt32BE(1025, 8);
  for (const bad of [
    illegal,
    hugeHeader,
    locked.subarray(0, locked.length - 1),
    new Uint8Array([...locked, 0]),
  ]) {
    const sizes: number[] = [];
    await assert.rejects(
      readVaultLocalFile(
        new Blob([bad]),
        signal(),
        () => {},
        async (blob) => {
          sizes.push(blob.size);
          return read(blob);
        },
      ),
      { code: "format" },
    );
    assert.ok(sizes.length <= 2);
    assert.ok(sizes.every((size) => size < bad.length));
  }
});

test("cancellation after header inspection never starts the full read; a changed prefix never returns the completed buffer", async () => {
  const locked = (
    await new WritingVaultCryptography().seal(plain, password, signal())
  ).bytes;
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(
    readVaultLocalFile(
      new Blob([locked]),
      abort.signal,
      () => {},
      async (blob) => {
        calls++;
        const result = await read(blob);
        if (calls === 2) abort.abort();
        return result;
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 2);
  let complete: Uint8Array<ArrayBuffer> | null = null;
  calls = 0;
  await assert.rejects(
    readVaultLocalFile(
      new Blob([locked]),
      signal(),
      () => {},
      async (blob) => {
        calls++;
        const result = await read(blob);
        if (calls === 3) {
          result[0]! ^= 1;
          complete = result;
        }
        return result;
      },
    ),
    { code: "read" },
  );
  assert.ok(complete);
  assert.ok((complete as Uint8Array).every((byte) => byte === 0));
});
