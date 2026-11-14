import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationTransport, NotificationRequestError } from "./notification-transport.ts";

const ACTOR = "通知讀者%2Fone, two";
const HEADER = "x-expected-notification-actor";
const ID = "10000000-0000-4000-8000-000000000001";
const ROW = { id: ID, eventKey: "notification-contract", payload: '{"type":"user.followed","followerId":"someone"}', createdAt: "2026-11-01T00:00:00.000Z", readAt: "2026-11-02T00:00:00.000Z" };
const signal = () => new AbortController().signal;
const problem = (code: string) => (error: unknown) => error instanceof NotificationRequestError && error.code === code;
function client(data: unknown) {
  return createNotificationTransport({ fetchImpl: async () => Response.json({ data }) });
}

test("identity comes from the private session response and does not require a UUID account", async () => {
  for (const id of ["legacy-notification-reader", "讀者甲", "reader%2Fname", "reader,name", "reader name", "讀".repeat(300)]) {
    assert.equal(await client({ id }).actor(signal()), id);
  }
});

test("an unusable or malformed session envelope cannot supply a notification recipient", async () => {
  for (const data of [null, [], {}, "reader", { id: null }, { id: 4 }, { id: "" }, { id: " padded" }, { id: "x".repeat(301) }, { id: "with\u0000control" }, { id: "\ud800" }]) {
    await assert.rejects(client(data).actor(signal()), problem("invalid-response"));
  }
  const broken = createNotificationTransport({ fetchImpl: async () => Response.json({ data: { id: ACTOR }, error: { code: "UNAVAILABLE" } }) });
  await assert.rejects(broken.actor(signal()), problem("invalid-response"));
});

test("all notification reads and writes carry one encoded actor restriction, but identity itself does not", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = createNotificationTransport({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/session")) return Response.json({ data: { id: ACTOR } });
    if (url.endsWith("/unread-count")) return Response.json({ data: 52 });
    if (url.endsWith("/read-all")) return Response.json({ data: 50 });
    if (url.endsWith("/read")) return Response.json({ data: ROW });
    return Response.json({ data: [ROW] });
  } });
  const actor = await transport.actor(signal());
  assert.equal(actor, ACTOR);
  assert.equal(await transport.count(signal(), actor), 52);
  assert.equal((await transport.page(null, signal(), actor)).items[0]!.id, ID);
  assert.equal((await transport.mark(ID, signal(), actor) as typeof ROW).readAt, ROW.readAt);
  assert.equal(await transport.mark(undefined, signal(), actor), 50);
  assert.deepEqual(calls.map(({ url }) => url), ["/api/authoring/session", "/api/authoring/notifications/unread-count", "/api/authoring/notifications?limit=50", `/api/authoring/notifications/${ID}/read`, "/api/authoring/notifications/read-all"]);
  for (let index = 0; index < calls.length; index++) {
    const { init } = calls[index]!;
    const headers = new Headers(init.headers);
    assert.equal(headers.get(HEADER), index === 0 ? null : encodeURIComponent(ACTOR));
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("idempotency-key"), null);
    assert.equal(init.body, undefined);
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
  }
});

test("missing, padded, oversized or non-encodable expected actors cannot turn into unbound operations", async () => {
  let fetched = 0;
  const transport = createNotificationTransport({ fetchImpl: async () => { fetched++; return Response.json({ data: 0 }); } });
  for (const value of [undefined, null, "", " reader", "reader ", "x".repeat(301), "a\nb", "\ud800"]) {
    // Exercise hostile untyped callers at the runtime boundary.
    const actor = value as string;
    await assert.rejects(transport.count(signal(), actor), problem("invalid-response"));
    await assert.rejects(transport.page(null, signal(), actor), problem("invalid-response"));
    await assert.rejects(transport.mark(undefined, signal(), actor), problem("invalid-response"));
    await assert.rejects(transport.mark(ID, signal(), actor), problem("invalid-response"));
  }
  assert.equal(fetched, 0);
});

test("an account mismatch has a dedicated non-diagnostic result on every notification endpoint", async () => {
  const transport = createNotificationTransport({ fetchImpl: async () => Response.json({ error: { code: "ACCOUNT_CHANGED", message: "synthetic-private-recipient" } }, { status: 409 }) });
  for (const work of [() => transport.count(signal(), ACTOR), () => transport.page(null, signal(), ACTOR), () => transport.mark(ID, signal(), ACTOR), () => transport.mark(undefined, signal(), ACTOR)]) {
    await assert.rejects(work(), (error: unknown) => {
      assert.ok(error instanceof NotificationRequestError);
      assert.equal(error.code, "account-changed");
      assert.doesNotMatch(error.message, /synthetic-private-recipient/);
      return true;
    });
  }
});

test("an unrelated 409 is not evidence that the account changed, and cannot be a success acknowledgement", async () => {
  for (const body of [{ error: { code: "SOME_OTHER_CONFLICT" } }, { data: 0 }, {}]) {
    const transport = createNotificationTransport({ fetchImpl: async () => Response.json(body, { status: 409 }) });
    await assert.rejects(transport.mark(undefined, signal(), ACTOR), problem("unavailable"));
    await assert.rejects(transport.count(signal(), ACTOR), problem("unavailable"));
  }
});

test("a malformed mismatch response is bounded and validated rather than trusted by status alone", async () => {
  for (const response of [
    () => new Response("ACCOUNT_CHANGED", { status: 409, headers: { "content-type": "text/html" } }),
    () => new Response('{"error":', { status: 409, headers: { "content-type": "application/json" } }),
    () => Response.json(["ACCOUNT_CHANGED"], { status: 409 }),
  ]) {
    const transport = createNotificationTransport({ fetchImpl: async () => response() });
    await assert.rejects(transport.count(signal(), ACTOR), problem("invalid-response"));
  }
});

test("recipient-specific errors never automatically replay either read-all or a single read", async () => {
  for (const id of [undefined, ID]) {
    let calls = 0;
    const transport = createNotificationTransport({ fetchImpl: async () => {
      calls++;
      return Response.json({ error: { code: "ACCOUNT_CHANGED" } }, { status: 409 });
    } });
    await assert.rejects(transport.mark(id, signal(), ACTOR), problem("account-changed"));
    assert.equal(calls, 1);
    await Promise.resolve();
    assert.equal(calls, 1);
  }
});

test("cancelling verification releases its body and cannot return a partially received actor", { timeout: 1000 }, async () => {
  const abort = new AbortController();
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let cancelled = false;
  const transport = createNotificationTransport({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"data":{"id":"')); open(); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } }) });
  const verifying = transport.actor(abort.signal);
  await opened;
  await Promise.resolve();
  abort.abort();
  await assert.rejects(verifying, problem("cancelled"));
  await Promise.resolve();
  assert.equal(cancelled, true);
});

test("a stalled identity has the same real deadline as private notification bodies", { timeout: 1000 }, async () => {
  let requestSignal: AbortSignal | null | undefined;
  const transport = createNotificationTransport({ timeoutMs: 20, fetchImpl: async (_url, init) => {
    requestSignal = init.signal;
    return new Promise<Response>(() => {});
  } });
  await assert.rejects(transport.actor(signal()), problem("timeout"));
  assert.equal(requestSignal?.aborted, true);
});
