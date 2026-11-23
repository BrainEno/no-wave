import assert from "node:assert/strict";
import { test } from "node:test";
import { createWritingBackup } from "./writing-backup.ts";
import { WritingVaultWorkbench } from "./writing-vault-controller.ts";
import {
  WritingVaultCryptography,
  type VaultOpened,
  type VaultSealed,
} from "./writing-vault-crypto.ts";
import { VAULT_FILE_LIMIT, VaultError } from "./writing-vault-format.ts";
import { inspectVaultPayload } from "./writing-vault-payload.ts";

const password = "fixture only password 文稿";
const stamp = new Date("2026-11-12T00:00:00.000Z");
const text = (title = "PRIVATE_TITLE") =>
  createWritingBackup(
    {
      title,
      summary: "",
      locale: "en",
      workType: "other",
      editorState: {
        root: {
          type: "root",
          version: 1,
          children: [
            {
              type: "paragraph",
              version: 1,
              children: [{ type: "text", version: 1, text: "PRIVATE_BODY" }],
            },
          ],
        },
      },
    },
    stamp,
  );
const file = (contents = text(), name = "private.json") =>
  new File([contents], name);
const read = async (value: File) => new Uint8Array(await value.arrayBuffer());
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function loaded(
  options: ConstructorParameters<typeof WritingVaultWorkbench>[0] = {},
) {
  const controller = new WritingVaultWorkbench({ read, ...options });
  await controller.load(file());
  return controller;
}
async function sealed() {
  const controller = await loaded();
  await controller.seal(password, password, true);
  const result = controller.getSnapshot().result;
  assert.ok(result);
  return { controller, result };
}

test("loading is a strict empty-to-ready transition; size lies, invalid payload and oversized input never become a source", async () => {
  let reads = 0;
  const controller = new WritingVaultWorkbench({
    read: async (value) => {
      reads++;
      return read(value);
    },
  });
  await controller.load({ size: VAULT_FILE_LIMIT + 1 } as File);
  assert.equal(reads, 0);
  assert.equal(controller.getSnapshot().source, null);
  await controller.load(file("{}"));
  assert.equal(controller.getSnapshot().source, null);
  const lying = new WritingVaultWorkbench({
    read: async () => new Uint8Array([123, 125]),
  });
  await lying.load(file());
  assert.equal(lying.getSnapshot().source, null);
  assert.equal(lying.getSnapshot().error?.code, "read");
  await controller.load(file());
  assert.equal(controller.getSnapshot().source?.kind, "plain");
  assert.equal(
    controller.getSnapshot().review?.documents[0]!.backup.draft.title,
    "PRIVATE_TITLE",
  );
});

test("old native reads, invalidations during publication and late errors never revive private source data", async () => {
  const old = deferred<Uint8Array<ArrayBuffer>>();
  const oldBytes = new TextEncoder().encode(text("OLD_PRIVATE"));
  const controller = await loaded({
    read: async (value) =>
      value.name === "old.json" ? old.promise : read(value),
  });
  const pending = controller.load(file(text("OLD_PRIVATE"), "old.json"));
  await controller.load(file(text("NEW_PRIVATE")));
  old.resolve(oldBytes);
  await pending;
  assert.equal(
    controller.getSnapshot().review?.documents[0]!.backup.draft.title,
    "NEW_PRIVATE",
  );
  assert.ok(
    oldBytes.every((value) => value === 0),
    "late byte ownership is explicitly released",
  );
  const release = controller.subscribe(() => {
    if (controller.getSnapshot().loading) controller.clear();
  });
  await controller.load(file());
  release();
  assert.equal(controller.getSnapshot().source, null);
  assert.equal(controller.getSnapshot().loading, false);
});

test("matching repeated password and risk consent precede encryption, and no password enters a published snapshot", async () => {
  let seals = 0;
  const native = new WritingVaultCryptography();
  const controller = await loaded({
    crypto: {
      verify: (...args) => new WritingVaultCryptography().verify(...args),
      seal: async (...args) => {
        seals++;
        return native.seal(...args);
      },
      open: native.open.bind(native),
    },
  });
  await controller.seal(password, password, false);
  await controller.seal(password, password + " ", true);
  assert.equal(seals, 0);
  assert.equal(controller.getSnapshot().result, null);
  const states: string[] = [];
  const off = controller.subscribe(() =>
    states.push(JSON.stringify(controller.getSnapshot())),
  );
  await controller.seal(password, password, true);
  off();
  assert.equal(seals, 1);
  assert.ok(controller.getSnapshot().result);
  assert.equal(
    controller.getSnapshot().review,
    null,
    "successful sealing drops the plaintext preview",
  );
  assert.equal(controller.getSnapshot().source, null);
  assert.ok(states.every((state) => !state.includes(password)));
});

test("every output needs a live, separate confirmation; changing credentials, relocking or source replacement revokes it", async () => {
  const { controller, result } = await sealed();
  assert.throws(() => controller.artifact(result), /确认|变化|旧结果/);
  controller.confirmResult(result, true);
  const artifact = controller.artifact(result);
  assert.equal(artifact.name, "no-wave-encrypted-writing-v1.nwvault");
  assert.equal(artifact.mime, "application/octet-stream");
  assert.doesNotMatch(artifact.name, /PRIVATE|private/);
  assert.equal(controller.permits(result), true);
  controller.credentialsChanged();
  assert.equal(controller.permits(result), false);
  assert.throws(() => controller.artifact(result));
  await controller.load(new File([artifact.bytes], "download.nwvault"));
  await controller.unlock(password);
  const opened = controller.getSnapshot().result!;
  assert.ok(opened);
  assert.equal(opened.kind, "plain");
  assert.throws(() => controller.artifact(opened));
  controller.confirmResult(opened, true);
  const plaintext = controller.artifact(opened);
  assert.equal(new TextDecoder().decode(plaintext.bytes), text());
  controller.lock();
  assert.equal(controller.getSnapshot().review, null);
  assert.equal(controller.getSnapshot().source?.kind, "locked");
  assert.throws(() => controller.artifact(opened));
  await controller.load(file());
  assert.equal(controller.getSnapshot().result, null);
});

test("verify-only authenticates and validates all content but retains no plaintext result or document preview", async () => {
  const { controller, result } = await sealed();
  controller.confirmResult(result, true);
  const artifact = controller.artifact(result);
  await controller.load(new File([artifact.bytes], "locked.nwvault"));
  await controller.verify(password);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "verified");
  assert.equal(snapshot.verified?.kind, "backup");
  assert.equal(snapshot.verified?.documents, 1);
  assert.equal(snapshot.result, null);
  assert.equal(snapshot.review, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_TITLE|PRIVATE_BODY/);
  await controller.unlock("wrong password only 文稿");
  assert.equal(controller.getSnapshot().verified, null);
  assert.equal(controller.getSnapshot().error?.code, "authentication");
  assert.equal(controller.getSnapshot().result, null);
});

test("late encryption success is wiped after password ABA changes, cancellation, clearing or another file", async () => {
  for (const change of ["credentials", "cancel", "clear", "load"] as const) {
    const native = new WritingVaultCryptography();
    const prepared = await native.seal(
      new TextEncoder().encode(text()),
      password,
      new AbortController().signal,
    );
    const gate = deferred<VaultSealed>();
    const controller = await loaded({
      crypto: {
        verify: (...args) => new WritingVaultCryptography().verify(...args),
        seal: async () => gate.promise,
        open: native.open.bind(native),
      },
    });
    const work = controller.seal(password, password, true);
    assert.equal(controller.getSnapshot().phase, "working");
    if (change === "credentials") {
      controller.credentialsChanged();
      controller.credentialsChanged();
    }
    if (change === "cancel") controller.cancel();
    if (change === "clear") controller.clear();
    if (change === "load") await controller.load(file(text("REPLACEMENT")));
    gate.resolve(prepared);
    await work;
    assert.equal(controller.getSnapshot().result, null);
    assert.ok(prepared.bytes.every((byte) => byte === 0));
  }
});

test("late decryption failure is payload-free and cannot overwrite a replacement input", async () => {
  const { controller: source, result } = await sealed();
  source.confirmResult(result, true);
  const encrypted = source.artifact(result);
  const gate = deferred<VaultOpened>();
  const controller = new WritingVaultWorkbench({
    read,
    crypto: {
      verify: (...args) => new WritingVaultCryptography().verify(...args),
      open: async () => gate.promise,
      seal: async () => {
        throw new VaultError("crypto");
      },
    },
  });
  await controller.load(new File([encrypted.bytes], "locked.nwvault"));
  const old = controller.unlock(password);
  await controller.load(file(text("REPLACEMENT")));
  gate.reject(new Error("PRIVATE_NATIVE_ERROR"));
  await old;
  assert.equal(
    controller.getSnapshot().review?.documents[0]!.backup.draft.title,
    "REPLACEMENT",
  );
  assert.equal(controller.getSnapshot().error, null);
});

test("readback compares the selected downloaded bytes, not names or JSON meaning; replacement/clear invalidates pending verification", async () => {
  const { controller, result } = await sealed();
  controller.confirmResult(result, true);
  const artifact = controller.artifact(result);
  await controller.verifyDownloaded(
    new File([artifact.bytes], "arbitrary-name.bin"),
    result,
  );
  assert.equal(controller.getSnapshot().readback.report?.matches, true);
  const corrupt = artifact.bytes.slice();
  corrupt[corrupt.length - 1]! ^= 1;
  await controller.verifyDownloaded(new File([corrupt], artifact.name), result);
  assert.equal(controller.getSnapshot().readback.report?.matches, false);
  assert.equal(
    controller.getSnapshot().result,
    result,
    "bad readback never silently replaces the prepared output",
  );
  const late = deferred<Uint8Array<ArrayBuffer>>();
  const waiting = await loaded({
    read: async (value) =>
      value.name === "late.bin" ? late.promise : read(value),
  });
  await waiting.seal(password, password, true);
  const witness = waiting.getSnapshot().result!;
  waiting.confirmResult(witness, true);
  const copied = waiting.artifact(witness).bytes;
  const work = waiting.verifyDownloaded(
    new File([copied], "late.bin"),
    witness,
  );
  waiting.clear();
  late.resolve(copied);
  await work;
  assert.equal(waiting.getSnapshot().readback.report, null);
  assert.ok(copied.every((byte) => byte === 0));
});

test("wrong-kind operations and fabricated/stale result witnesses cannot download or bypass confirmation", async () => {
  const controller = await loaded();
  await controller.unlock(password);
  assert.equal(controller.getSnapshot().result, null);
  assert.equal(controller.getSnapshot().source?.kind, "plain");
  await controller.seal(password, password, true);
  const witness = controller.getSnapshot().result!;
  controller.confirmResult({ ...witness }, true);
  assert.equal(controller.permits(witness), false);
  controller.confirmResult(witness, true);
  assert.throws(() => controller.artifact({ ...witness }));
  const copy = controller.artifact(witness);
  copy.bytes.fill(0);
  assert.ok(
    controller.artifact(witness).bytes.some((byte) => byte !== 0),
    "downloads never expose the owner's mutable buffer",
  );
});

test("a verify-only completion transfers no retained plaintext even when its consumer clears synchronously", async () => {
  const native = new WritingVaultCryptography();
  const result = await native.seal(
    new TextEncoder().encode(text()),
    password,
    new AbortController().signal,
  );
  const plain = new TextEncoder().encode(text());
  const review = await inspectVaultPayload(plain, new AbortController().signal);
  const verifier = new WritingVaultCryptography();
  verifier.open = async () => ({ bytes: plain, review });
  const controller = new WritingVaultWorkbench({
    read,
    crypto: {
      verify: verifier.verify.bind(verifier),
      seal: native.seal.bind(native),
      open: async () => ({ bytes: plain, review }),
    },
  });
  await controller.load(new File([result.bytes], "locked.nwvault"));
  const off = controller.subscribe(() => {
    if (controller.getSnapshot().phase === "verified") controller.clear();
  });
  await controller.verify(password);
  off();
  assert.ok(plain.every((byte) => byte === 0));
  assert.equal(controller.getSnapshot().verified, null);
});

test("manual rotation requires a second distinct confirmed password and returns only a new encrypted artifact", async () => {
  const { controller, result } = await sealed();
  controller.confirmResult(result, true);
  const original = controller.artifact(result);
  await controller.load(new File([original.bytes], "old.nwvault"));
  const next = "new independent 文稿 passphrase";
  await controller.rotate(password, next, next, false);
  assert.equal(controller.getSnapshot().result, null);
  await controller.rotate(password, next, next + " ", true);
  assert.equal(controller.getSnapshot().result, null);
  await controller.rotate(password, next, next, true);
  const rotated = controller.getSnapshot().result!;
  assert.equal(rotated.kind, "sealed");
  assert.equal(controller.getSnapshot().review, null);
  controller.confirmResult(rotated, true);
  const output = controller.artifact(rotated);
  await controller.load(new File([output.bytes], "new.nwvault"));
  await controller.unlock(next);
  assert.equal(
    controller.getSnapshot().review?.documents[0]!.backup.draft.title,
    "PRIVATE_TITLE",
  );
});

test("a cancelled worker inspection cannot publish a ready source or retain the selected bytes", async () => {
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = deferred<Awaited<ReturnType<typeof inspectVaultPayload>>>();
  const original = new TextEncoder().encode(text());
  const review = await inspectVaultPayload(original);
  const controller = new WritingVaultWorkbench({
    read: async () => original,
    inspect: async () => {
      reached();
      return gate.promise;
    },
  });
  const work = controller.load(file());
  await Promise.race([
    entered,
    work.then(() => {
      throw new Error("未进入可取消的独立检查器");
    }),
  ]);
  controller.clear();
  gate.resolve(review);
  await work;
  assert.equal(controller.getSnapshot().source, null);
  assert.ok(original.every((byte) => byte === 0));
});

test("bounded raw preview and exact-byte search need a live review witness; clear, relock and changed sources revoke both", async () => {
  const controller = await loaded(),
    review = controller.getSnapshot().review!;
  assert.equal(controller.previewPage(review, 0).text, text());
  assert.equal(
    (await controller.searchPreview(review, "PRIVATE_BODY", 0)).hits.length,
    1,
  );
  assert.throws(() => controller.previewPage({ ...review }, 0), {
    code: "stale",
  });
  controller.clear();
  assert.throws(() => controller.previewPage(review, 0), { code: "stale" });
  await assert.rejects(controller.searchPreview(review, "PRIVATE_BODY", 0));
});

test("late raw search cannot return navigation offsets after cancellation or a replacement file, even when the scanner ignores abort", async () => {
  const gate = deferred<{
    hits: { start: number; end: number }[];
    complete: boolean;
    scannedBytes: number;
  }>();
  const controller = await loaded({ search: async () => gate.promise });
  const review = controller.getSnapshot().review!;
  const pending = controller.searchPreview(review, "PRIVATE_BODY", 0);
  controller.cancelPreviewSearch();
  await controller.load(file(text("NEW_PRIVATE")));
  gate.resolve({
    hits: [{ start: 0, end: 2 }],
    complete: true,
    scannedBytes: 2,
  });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(
    controller.getSnapshot().review?.documents[0]?.backup.draft.title,
    "NEW_PRIVATE",
  );
});

test("a bounded local-file preflight rejection keeps its fixed format error and never starts payload inspection or a KDF", async () => {
  let inspected = 0;
  const controller = new WritingVaultWorkbench({
    read: async () => {
      throw new VaultError("format");
    },
    inspect: async () => {
      inspected++;
      throw new Error("must not inspect");
    },
  });
  await controller.load(file());
  assert.equal(controller.getSnapshot().error?.code, "format");
  assert.equal(inspected, 0);
  assert.equal(controller.getSnapshot().source, null);
});
