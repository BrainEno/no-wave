import assert from "node:assert/strict";
import { test } from "node:test";
import { createWritingBackup } from "./writing-backup.ts";
import { WritingVaultCryptography } from "./writing-vault-crypto.ts";
import { WritingVaultWorkerClient } from "./writing-vault-worker-client.ts";
import {
  installVaultWorker,
  VAULT_WORKER_PROTOCOL,
  type VaultWorkerPort,
} from "./writing-vault-worker-protocol.ts";

const password = "fixture worker 文稿 passphrase";
const payload = new TextEncoder().encode(
  createWritingBackup(
    {
      title: "PRIVATE_WORKER_TITLE",
      summary: "",
      locale: "zh-CN",
      workType: "essay",
      editorState: {
        root: {
          type: "root",
          version: 1,
          children: [
            {
              type: "paragraph",
              version: 1,
              children: [
                { type: "text", version: 1, text: "PRIVATE_WORKER_BODY" },
              ],
            },
          ],
        },
      },
    },
    new Date("2026-11-12T00:00:00.000Z"),
  ),
);
function abortError() {
  return { name: "AbortError" };
}
class FakeWorker extends EventTarget implements VaultWorkerPort {
  sent: unknown[] = [];
  terminated = 0;
  throwPost = false;
  postMessage(message: unknown, _transfer: Transferable[] = []) {
    if (this.throwPost) throw new Error("PRIVATE_POST_ERROR");
    this.sent.push(structuredClone(message));
  }
  terminate() {
    this.terminated++;
  }
  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  ready() {
    this.emit({ protocol: VAULT_WORKER_PROTOCOL, kind: "ready" });
  }
}
function preparedClient() {
  const worker = new FakeWorker();
  const timers: (() => void)[] = [];
  const client = new WritingVaultWorkerClient({
    create: () => worker,
    later: (work) => {
      timers.push(work);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancelTimer: () => {},
  });
  client.warm();
  worker.ready();
  assert.equal(client.getSnapshot(), "idle");
  return { worker, client, timers };
}
function latest(worker: FakeWorker) {
  return worker.sent.at(-1) as {
    id: number;
    kind: string;
    input: Uint8Array;
    password: string;
  };
}

test("a worker does no secret work before a validated startup handshake; wrong identifiers cannot free an active slot", async () => {
  const { worker, client } = preparedClient(),
    abort = new AbortController();
  const pending = client.seal(payload, password, abort.signal);
  const request = latest(worker);
  assert.equal(request.kind, "run");
  assert.equal(request.password, password);
  assert.notEqual(request.input, payload);
  assert.equal(client.getSnapshot(), "busy");
  await assert.rejects(
    client.seal(payload, password, new AbortController().signal),
  );
  worker.emit({
    protocol: VAULT_WORKER_PROTOCOL,
    kind: "failed",
    id: request.id + 1,
    code: "authentication",
  });
  assert.equal(client.getSnapshot(), "busy");
  worker.emit({
    protocol: VAULT_WORKER_PROTOCOL,
    kind: "failed",
    id: request.id,
    code: "authentication",
    message: "PRIVATE_NATIVE",
  });
  await assert.rejects(pending, (e: unknown) => {
    assert.doesNotMatch(String(e), /PRIVATE_NATIVE/);
    return true;
  });
  assert.equal(
    client.getSnapshot(),
    "failed",
    "unexpected diagnostic fields terminate the protocol instead of being admitted",
  );
});

test("cancel keeps the worker busy until its terminal response; late plaintext is wiped instead of being returned", async () => {
  const { worker, client } = preparedClient(),
    abort = new AbortController();
  const pending = client.inspect(payload, abort.signal);
  const request = latest(worker);
  abort.abort();
  assert.equal(latest(worker).kind, "cancel");
  assert.equal(client.getSnapshot(), "busy");
  const bytes = payload.slice();
  worker.emit({
    protocol: VAULT_WORKER_PROTOCOL,
    kind: "complete",
    id: request.id,
    result: { bytes, review: null },
  });
  await assert.rejects(pending, abortError());
  assert.ok(bytes.every((byte) => byte === 0));
  assert.equal(client.getSnapshot(), "idle");
});

test("timeout, worker crash, malformed replies and posting failure fail closed with no automatic restart or secret-bearing diagnostics", async () => {
  for (const mode of ["timeout", "crash", "malformed", "post"] as const) {
    const { worker, client, timers } = preparedClient();
    if (mode === "post") worker.throwPost = true;
    const pending = client.seal(
      payload,
      password,
      new AbortController().signal,
    );
    if (mode === "timeout") timers.at(-1)!();
    if (mode === "crash") worker.dispatchEvent(new Event("error"));
    if (mode === "malformed")
      worker.emit({
        protocol: VAULT_WORKER_PROTOCOL,
        kind: "complete",
        id: latest(worker).id,
        result: { bytes: payload.slice(), review: null },
      });
    await assert.rejects(pending, (e: unknown) => {
      assert.doesNotMatch(String(e), /PRIVATE_|passphrase/);
      return true;
    });
    assert.equal(client.getSnapshot(), "failed");
    assert.equal(worker.terminated, 1);
    client.warm();
    assert.equal(client.getSnapshot(), "failed");
    await assert.rejects(
      client.seal(payload, password, new AbortController().signal),
    );
  }
});

test("pre-aborted and synchronous subscriber cancellation never post a password job", async () => {
  const { worker, client } = preparedClient(),
    abort = new AbortController();
  abort.abort();
  await assert.rejects(
    client.seal(payload, password, abort.signal),
    abortError(),
  );
  assert.equal(worker.sent.length, 0);
  const second = new AbortController();
  const off = client.subscribe(() => {
    if (client.getSnapshot() === "busy") second.abort();
  });
  await assert.rejects(
    client.seal(payload, password, second.signal),
    abortError(),
  );
  off();
  assert.equal(worker.sent.length, 0);
  assert.equal(client.getSnapshot(), "idle");
});

test("worker-side protocol admits one bounded request, cancels by exact job ID and emits only fixed errors", async () => {
  const events: unknown[] = [];
  const scope = new EventTarget() as EventTarget & {
    postMessage: (data: unknown, transfer?: Transferable[]) => void;
  };
  let cancelled!: () => void;
  const terminal = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  scope.postMessage = (data) => {
    events.push(data);
    if ((data as { kind: string }).kind === "cancelled") cancelled();
  };
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const native = new WritingVaultCryptography();
  installVaultWorker(scope, {
    inspect: native.inspect.bind(native),
    verify: native.verify.bind(native),
    rotate: native.rotate.bind(native),
    open: native.open.bind(native),
    seal: async (...args) => {
      calls++;
      entered();
      await gate;
      return native.seal(...args);
    },
  });
  const send = (data: unknown) =>
    scope.dispatchEvent(new MessageEvent("message", { data }));
  const request = {
    protocol: VAULT_WORKER_PROTOCOL,
    kind: "run",
    id: 7,
    action: "seal",
    input: payload.slice(),
    password,
    replacement: "",
  };
  send(request);
  await started;
  send({ ...request, id: 8, input: payload.slice(), password });
  send({ protocol: VAULT_WORKER_PROTOCOL, kind: "cancel", id: 7 });
  finish();
  await terminal;
  assert.equal(calls, 1);
  assert.ok(
    events.some((event) => (event as { kind: string }).kind === "cancelled"),
  );
  assert.ok(
    events.some((event) => (event as { code: string }).code === "busy"),
  );
  assert.ok(request.input.every((byte) => byte === 0));
  assert.equal(request.password, "");
  assert.doesNotMatch(
    JSON.stringify(events),
    /PRIVATE_|passphrase|OperationError/,
  );
});

test("a real protocol bridge uses the production crypto engine for inspect, seal, unlock and manual rotation", async () => {
  const outer = new FakeWorker();
  const scope = new EventTarget() as EventTarget & {
    postMessage: (data: unknown, transfer?: Transferable[]) => void;
  };
  const transfers: number[] = [];
  scope.postMessage = (data, transfer) => {
    transfers.push(transfer?.length ?? 0);
    queueMicrotask(() => outer.emit(data));
  };
  outer.postMessage = (data: unknown) => {
    const copied = structuredClone(data);
    outer.sent.push(copied);
    queueMicrotask(() =>
      scope.dispatchEvent(new MessageEvent("message", { data: copied })),
    );
  };
  const client = new WritingVaultWorkerClient({ create: () => outer });
  client.warm();
  installVaultWorker(scope, new WritingVaultCryptography());
  await new Promise((resolve) => setImmediate(resolve));
  const reviewed = await client.inspect(payload, new AbortController().signal);
  assert.equal(reviewed.review.kind, "backup");
  assert.deepEqual(reviewed.bytes, payload);
  const sealed = await client.seal(
    payload,
    password,
    new AbortController().signal,
  );
  const opened = await client.open(
    sealed.bytes,
    password,
    new AbortController().signal,
  );
  assert.deepEqual(opened.bytes, payload);
  const next = "replacement 文稿 worker passphrase";
  const rotated = await client.rotate(
    sealed.bytes,
    password,
    next,
    new AbortController().signal,
  );
  assert.deepEqual(
    (await client.open(rotated.bytes, next, new AbortController().signal))
      .bytes,
    payload,
  );
  assert.ok(transfers.some((value) => value === 1));
  client.dispose();
});

test("verify-only transfers only a closed content-free receipt; plaintext buffers and review trees never cross its Worker reply", async () => {
  const outer = new FakeWorker(),
    events: unknown[] = [];
  const scope = new EventTarget() as EventTarget & {
    postMessage: (data: unknown, transfer?: Transferable[]) => void;
  };
  scope.postMessage = (data, transfer = []) => {
    const copied = structuredClone(data);
    events.push(copied);
    if ((data as { kind: string }).kind === "complete")
      assert.equal(transfer.length, 0);
    queueMicrotask(() => outer.emit(copied));
  };
  outer.postMessage = (data) => {
    const copied = structuredClone(data);
    outer.sent.push(copied);
    queueMicrotask(() =>
      scope.dispatchEvent(new MessageEvent("message", { data: copied })),
    );
  };
  const client = new WritingVaultWorkerClient({ create: () => outer });
  client.warm();
  installVaultWorker(scope, new WritingVaultCryptography());
  await new Promise((resolve) => setImmediate(resolve));
  const locked = await new WritingVaultCryptography().seal(
    payload,
    password,
    new AbortController().signal,
  );
  const receipt = await client.verify(
    locked.bytes,
    password,
    new AbortController().signal,
  );
  assert.deepEqual(Object.keys(receipt).sort(), [
    "bytes",
    "decisions",
    "digest",
    "documents",
    "kind",
  ]);
  assert.equal(receipt.documents, 1);
  assert.equal(receipt.kind, "backup");
  assert.doesNotMatch(
    JSON.stringify(events),
    /PRIVATE_|editorState|children|draft|passphrase/,
  );
  client.dispose();
});

test("unexpected reply fields and non-owned result buffers terminate the channel rather than admitting a partial or ambiguous job receipt", async () => {
  const reviewed = await new WritingVaultCryptography().inspect(
    payload,
    new AbortController().signal,
  );
  for (const mode of [
    "stage-extra",
    "failure-extra",
    "complete-extra",
    "subview",
  ] as const) {
    const { client, worker } = preparedClient();
    const pending = client.inspect(payload, new AbortController().signal);
    const outcome = pending.then(
      () => null,
      (error) => error as Error,
    );
    const id = latest(worker).id;
    if (mode === "stage-extra")
      worker.emit({
        protocol: VAULT_WORKER_PROTOCOL,
        kind: "stage",
        id,
        stage: "deriving",
        extra: "PRIVATE_REPLY",
      });
    if (mode === "failure-extra")
      worker.emit({
        protocol: VAULT_WORKER_PROTOCOL,
        kind: "failed",
        id,
        code: "authentication",
        extra: "PRIVATE_REPLY",
      });
    if (mode === "complete-extra")
      worker.emit({
        protocol: VAULT_WORKER_PROTOCOL,
        kind: "complete",
        id,
        result: {
          bytes: payload.slice(),
          review: reviewed.review,
          extra: "PRIVATE_REPLY",
        },
      });
    if (mode === "subview")
      worker.emit({
        protocol: VAULT_WORKER_PROTOCOL,
        kind: "complete",
        id,
        result: {
          bytes: new Uint8Array(payload.length + 1).subarray(1),
          review: reviewed.review,
        },
      });
    assert.equal(client.getSnapshot(), "failed", mode);
    const error = await outcome;
    assert.equal((error as { code?: string })?.code, "worker");
    assert.doesNotMatch(String(error), /PRIVATE_REPLY/);
  }
});
