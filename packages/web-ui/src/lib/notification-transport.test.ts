import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationTransport, NOTIFICATION_BODY_LIMIT, NotificationRequestError } from "./notification-transport.ts";
import { notificationCursor } from "./notification-pages.ts";
import type { NotificationItem } from "./chrome.ts";

const row: NotificationItem = { id: "11111111-1111-4111-8111-111111111111", eventKey: "event-one", payload: '{"type":"future.notice"}', createdAt: "2026-11-01T00:00:00.000Z", readAt: null };
const signal = () => new AbortController().signal;
const problem = (code: string) => (error: unknown) => error instanceof NotificationRequestError && error.code === code;

test("notification transport uses only private same-origin endpoints and fixed request options", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createNotificationTransport({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/unread-count")) return Response.json({ data: 7 });
    if (url.endsWith("/read-all")) return Response.json({ data: 4 });
    if (url.endsWith("/read")) return Response.json({ data: { ...row, readAt: "2026-11-02T00:00:00.000Z" } });
    return Response.json({ data: [row] });
  } });
  assert.equal(await client.count(signal()), 7);
  assert.deepEqual((await client.page(null, signal())).items, [row]);
  const cursor = notificationCursor(row);
  await client.page(cursor, signal());
  assert.equal((await client.mark(row.id, signal()) as NotificationItem).readAt, "2026-11-02T00:00:00.000Z");
  assert.equal(await client.mark(undefined, signal()), 4);
  assert.deepEqual(requests.map(({ init }) => init.method), ["GET", "GET", "GET", "PUT", "POST"]);
  assert.equal(requests[1]!.url, "/api/authoring/notifications?limit=50");
  assert.equal(new URL(requests[2]!.url, "https://local.invalid").searchParams.get("cursor"), cursor);
  assert.equal(requests[3]!.url, `/api/authoring/notifications/${row.id}/read`);
  for (const { url, init } of requests) {
    assert.ok(url.startsWith("/api/authoring/notifications"));
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), { accept: "application/json" });
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test("counts require the API envelope and exact non-negative safe integers, not rounded badges", async () => {
  for (const value of [0, 1, 100, Number.MAX_SAFE_INTEGER]) {
    const client = createNotificationTransport({ fetchImpl: async () => Response.json({ data: value }) });
    assert.equal(await client.count(signal()), value);
  }
  for (const value of [-1, 0.5, "4", true, null, {}, Number.MAX_SAFE_INTEGER + 1]) {
    const client = createNotificationTransport({ fetchImpl: async () => Response.json({ data: value }) });
    await assert.rejects(client.count(signal()), problem("invalid-response"));
  }
  for (const payload of [5, [], {}, { data: 5, error: { code: "INTERNAL" } }]) {
    const client = createNotificationTransport({ fetchImpl: async () => Response.json(payload) });
    await assert.rejects(client.count(signal()), problem("invalid-response"));
  }
});

test("all rows need usable cursor identities and real millisecond timestamps, even on short pages", async () => {
  const badRows = [
    { ...row, id: "notice-1" }, { ...row, id: "" }, { ...row, eventKey: " " },
    { ...row, eventKey: "x".repeat(513) }, { ...row, payload: {} },
    { ...row, createdAt: "2026-02-30T00:00:00.000Z" },
    { ...row, createdAt: "2026-11-01T00:00:00Z" },
    { ...row, readAt: "not-a-date" }, { ...row, readAt: "2026-11-02T00:00:00.000+00:00" },
  ];
  for (const bad of badRows) {
    const client = createNotificationTransport({ fetchImpl: async () => Response.json({ data: [bad] }) });
    await assert.rejects(client.page(null, signal()), problem("invalid-response"));
  }
  const client = createNotificationTransport({ fetchImpl: async () => Response.json({ data: [row, row] }) });
  await assert.rejects(client.page(null, signal()), problem("invalid-response"));
});

test("a future or malformed payload stays readable and does not turn a real row into a short page", async () => {
  for (const payload of ['{"type":"a.future.kind","url":"https://outside.invalid"}', "not-json", "null"]) {
    const client = createNotificationTransport({ fetchImpl: async () => Response.json({ data: [{ ...row, payload }] }) });
    const page = await client.page(null, signal());
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.payload, payload);
  }
});

test("a full valid page has the API-compatible continuation; oversize and malformed pages are errors", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ ...row, id: `10000000-0000-4000-8000-${(50 - index).toString(16).padStart(12, "0")}` }));
  const client = createNotificationTransport({ fetchImpl: async () => Response.json({ data: rows }) });
  assert.equal((await client.page(null, signal())).nextCursor, notificationCursor(rows[49]!));
  for (const data of [rows.concat(row), null, {}, [null]]) {
    const invalid = createNotificationTransport({ fetchImpl: async () => Response.json({ data }) });
    await assert.rejects(invalid.page(null, signal()), problem("invalid-response"));
  }
});

test("mutation acknowledgements are not inferred from HTTP 200 or from a changed-row count", async () => {
  for (const data of [null, 1, { ...row }, { ...row, id: "22222222-2222-4222-8222-222222222222", readAt: "2026-11-02T00:00:00.000Z" }]) {
    const client = createNotificationTransport({ fetchImpl: async () => Response.json({ data }) });
    await assert.rejects(client.mark(row.id, signal()), problem("invalid-response"));
  }
  for (const data of ["3", -1, 0.5, {}, null]) {
    const client = createNotificationTransport({ fetchImpl: async () => Response.json({ data }) });
    await assert.rejects(client.mark(undefined, signal()), problem("invalid-response"));
  }
  const zero = createNotificationTransport({ fetchImpl: async () => Response.json({ data: 0 }) });
  assert.equal(await zero.mark(undefined, signal()), 0, "an idempotent mark-all is a valid acknowledgement, not an unread total");
});

test("invalid notification IDs, cursors and already-cancelled calls never reach fetch", async () => {
  let reads = 0;
  const client = createNotificationTransport({ fetchImpl: async () => { reads++; return Response.json({ data: 0 }); } });
  for (const id of ["..", "//outside.invalid", "", `${row.id}/read`, "x".repeat(1000)]) await assert.rejects(client.mark(id, signal()), problem("invalid-response"));
  for (const cursor of ["", "has space", "?user=other", "x".repeat(513)]) await assert.rejects(client.page(cursor, signal()), problem("invalid-response"));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.count(cancelled.signal), problem("cancelled"));
  assert.equal(reads, 0);
});

test("unauthenticated replies have their own signal and never expose an upstream diagnostic", async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const client = createNotificationTransport({ fetchImpl: async () => Response.json({ error: { message: "synthetic-private-diagnostic" } }, { status }) });
    await assert.rejects(client.count(signal()), (error: unknown) => {
      assert.ok(error instanceof NotificationRequestError);
      assert.equal(error.code, status === 401 ? "unauthenticated" : "unavailable");
      assert.doesNotMatch(error.message, /synthetic-private-diagnostic/);
      return true;
    });
  }
});

test("HTML, broken JSON, error envelopes and invalid UTF-8 cannot become successful counts", async () => {
  const responses = [
    () => new Response("<h1>private</h1>", { headers: { "content-type": "text/html" } }),
    () => new Response("broken", { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    () => Response.json({ data: 0, error: "failed" }),
    () => new Response(null, { status: 204 }),
  ];
  for (const response of responses) {
    const client = createNotificationTransport({ fetchImpl: async () => response() });
    await assert.rejects(client.count(signal()), problem("invalid-response"));
  }
});

test("decoded bytes are bounded even if Content-Length lies, and oversized streams are cancelled", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(NOTIFICATION_BODY_LIMIT + 1).fill(32)); },
    cancel() { cancelled = true; },
  });
  const client = createNotificationTransport({ fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json", "content-length": "1" } }) });
  await assert.rejects(client.count(signal()), problem("invalid-response"));
  assert.equal(cancelled, true);
  const declared = createNotificationTransport({ fetchImpl: async () => new Response('{"data":0}', { headers: { "content-type": "application/json", "content-length": String(NOTIFICATION_BODY_LIMIT + 1) } }) });
  await assert.rejects(declared.count(signal()), problem("invalid-response"));
});

test("UTF-8 split across chunks remains valid within the body budget", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ data: [{ ...row, payload: "新通知𠀀" }] }));
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const client = createNotificationTransport({ fetchImpl: async () => new Response(stream, { headers: { "content-type": "application/json; charset=utf-8" } }) });
  assert.equal((await client.page(null, signal())).items[0]!.payload, "新通知𠀀");
});

test("a hung transport has a real deadline even if it ignores AbortSignal", { timeout: 1000 }, async () => {
  let requestSignal: AbortSignal | undefined;
  const client = createNotificationTransport({ timeoutMs: 20, fetchImpl: async (_url, init) => {
    requestSignal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  } });
  await assert.rejects(client.count(signal()), problem("timeout"));
  assert.equal(requestSignal?.aborted, true);
});

test("caller cancellation interrupts an uncooperative request before the normal timeout", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const client = createNotificationTransport({ timeoutMs: 500, fetchImpl: async () => { started(); return new Promise<Response>(() => {}); } });
  const request = client.count(controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(request, problem("cancelled"));
});

test("cancelling a stalled body releases its reader rather than waiting for JSON forever", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  let cancelled = false;
  const client = createNotificationTransport({ fetchImpl: async () => {
    const stream = new ReadableStream<Uint8Array>({ start() { opened(); }, cancel() { cancelled = true; } });
    return new Response(stream, { headers: { "content-type": "application/json" } });
  } });
  const request = client.count(controller.signal);
  await ready;
  await Promise.resolve();
  controller.abort();
  await assert.rejects(request, problem("cancelled"));
  await Promise.resolve();
  assert.equal(cancelled, true);
});

test("invalid deadline settings fail before opening a request", () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => createNotificationTransport({ timeoutMs }), RangeError);
});
