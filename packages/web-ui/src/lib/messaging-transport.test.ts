import assert from "node:assert/strict";
import test from "node:test";
import { createMessagingTransport, isMessagingActor, MESSAGING_RESPONSE_MAX_BYTES, MessagingRequestError, type MessagingIntent, type MessagingProblem } from "./messaging-transport.ts";

const ACTOR = "46d3e369-309c-47ba-9bba-33abde56ce19";
const RECIPIENT = "83203dcf-de13-41f3-900c-c8502018640f";
const CONVERSATION = "99f56d2b-4be5-455e-97ca-8fe97f0aee8d";
const MESSAGE = { id: "20f703d8-cc67-46de-a81c-437f3b26b112", conversationId: CONVERSATION, senderId: ACTOR, body: "A private message.", createdAt: "2026-11-01T00:00:00.000Z" };
const reply: MessagingIntent = { target: { kind: "reply", conversationId: CONVERSATION }, actorId: ACTOR, key: "same-intent-key", value: MESSAGE.body, payload: JSON.stringify({ body: MESSAGE.body }) };
const start: MessagingIntent = { target: { kind: "start" }, actorId: ACTOR, key: "same-start-key", value: RECIPIENT, payload: JSON.stringify({ participantIds: [RECIPIENT] }) };
const read: MessagingIntent = { target: { kind: "read", conversationId: CONVERSATION }, actorId: ACTOR, key: null, value: "", payload: undefined };
const signal = () => new AbortController().signal;
const problem = (code: MessagingProblem) => (error: unknown) => error instanceof MessagingRequestError && error.code === code;

function responseClient(payload: unknown, status = 200) {
  return createMessagingTransport({ fetchImpl: async () => Response.json(payload, { status }) });
}

test("messaging requests use fixed private paths, restrictive actor headers and no shared caches", async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const client = createMessagingTransport({ fetchImpl: async (path, init) => {
    calls.push({ path, init });
    if (path === "/api/authoring/session") return Response.json({ data: { id: ACTOR } });
    if (path.endsWith("/read")) return Response.json({ data: true });
    if (path.endsWith("/messages")) return Response.json({ data: MESSAGE }, { status: 201 });
    return Response.json({ data: { id: CONVERSATION, participantIds: [RECIPIENT, ACTOR] } }, { status: 201 });
  } });
  assert.equal(await client.actor(signal()), ACTOR);
  assert.deepEqual(await client.submit(start, signal()), { kind: "start", conversationId: CONVERSATION });
  assert.deepEqual(await client.submit(reply, signal()), { kind: "reply", message: MESSAGE });
  assert.deepEqual(await client.submit(read, signal()), { kind: "read" });
  assert.deepEqual(calls.map((call) => call.path), ["/api/authoring/session", "/api/authoring/inbox", `/api/authoring/inbox/${CONVERSATION}/messages`, `/api/authoring/inbox/${CONVERSATION}/read`]);
  assert.deepEqual(calls.map((call) => call.init.method), ["GET", "POST", "POST", "PUT"]);
  assert.deepEqual(calls.map((call) => call.init.body), [undefined, start.payload, reply.payload, undefined]);
  for (const [index, { init }] of calls.entries()) {
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("x-expected-messaging-actor"), index === 0 ? null : ACTOR);
    assert.equal(headers.get("idempotency-key"), index === 1 ? start.key : index === 2 ? reply.key : null);
    assert.equal(headers.get("content-type"), index === 1 || index === 2 ? "application/json" : null);
  }
});

test("only a usable API-derived account can enable mutation controls", async () => {
  for (const id of [ACTOR, "legacy-reader_2", "x".repeat(300), "讀者甲", "reader one", "reader,name", "reader%2Fname"]) {
    assert.equal(isMessagingActor(id), true);
    assert.equal(await responseClient({ data: { id } }).actor(signal()), id);
  }
  for (const id of [null, 4, "", " ", " padded", "with\ttab", "with\u0000control", "\ud800", "x".repeat(301)]) {
    assert.equal(isMessagingActor(id), false, String(id));
    await assert.rejects(responseClient({ data: { id } }).actor(signal()), problem("invalid-response"));
  }
});

test("the transport refuses forged actor, path, payload or key combinations without fetching", async () => {
  let calls = 0;
  const client = createMessagingTransport({ fetchImpl: async () => { calls++; return Response.json({ data: MESSAGE }); } });
  const bad: MessagingIntent[] = [
    { ...reply, actorId: "" },
    { ...reply, actorId: " padded" },
    { ...reply, target: { kind: "reply", conversationId: "../messages" } },
    { ...reply, target: { kind: "read", conversationId: "https://other.test" } },
    { ...reply, key: null }, { ...reply, key: "" }, { ...reply, key: "x".repeat(301) },
    { ...reply, payload: JSON.stringify({ body: "not the retained text" }) },
    { ...reply, payload: JSON.stringify({ body: reply.value, senderId: ACTOR }) },
    { ...reply, value: " padded " },
    { ...reply, value: "x".repeat(20_001) },
    { ...start, value: ACTOR, payload: JSON.stringify({ participantIds: [ACTOR] }) },
    { ...start, value: "x".repeat(301) },
    { ...read, key: "not-allowed" }, { ...read, payload: "{}" }, { ...read, value: "not-empty" },
  ];
  for (const intent of bad) await assert.rejects(client.submit(intent, signal()), problem("invalid"));
  assert.equal(calls, 0);
});

test("a message acknowledgment must match sender, conversation, text and valid persisted identifiers", async () => {
  const bad = [
    null, [], {}, { ...MESSAGE, id: "" }, { ...MESSAGE, id: "not-a-uuid" },
    { ...MESSAGE, senderId: RECIPIENT }, { ...MESSAGE, conversationId: ACTOR },
    { ...MESSAGE, body: "different text" }, { ...MESSAGE, createdAt: "invalid" },
    { ...MESSAGE, createdAt: "2026-02-30T00:00:00.000Z" },
    { ...MESSAGE, createdAt: "2026-11-01T00:00:00+00:00" },
    { ...MESSAGE, createdAt: "2026-11-01T00:00:00.000+08:00" },
  ];
  for (const data of bad) {
    await assert.rejects(responseClient({ data }, 201).submit(reply, signal()), problem("invalid-response"), JSON.stringify(data));
  }
  const replay = await responseClient({ data: { ...MESSAGE, duplicate: true } }, 201).submit(reply, signal());
  assert.deepEqual(replay, { kind: "reply", message: MESSAGE });
  assert.equal(Object.isFrozen(replay), true);
  assert.ok(replay.kind === "reply");
  assert.equal(Object.isFrozen(replay.message), true);
});

test("conversation acknowledgment verifies a safe destination and both original participants", async () => {
  const good = { id: CONVERSATION, participantIds: [ACTOR, RECIPIENT] };
  for (const data of [
    {}, { ...good, id: "//other.test/messages" }, { ...good, participantIds: [] },
    { ...good, participantIds: [ACTOR] }, { ...good, participantIds: [RECIPIENT] },
    { ...good, participantIds: [ACTOR, RECIPIENT, ACTOR] },
    { ...good, participantIds: [ACTOR, RECIPIENT, null] },
    { ...good, participantIds: [ACTOR, "someone-else"] },
  ]) await assert.rejects(responseClient({ data }, 201).submit(start, signal()), problem("invalid-response"));
  assert.deepEqual(await responseClient({ data: { ...good, participantIds: [RECIPIENT, "a-new-member", ACTOR] } }, 201).submit(start, signal()), { kind: "start", conversationId: CONVERSATION });
});

test("mark-all needs the API's boolean acknowledgment, never a changed-count or an empty object", async () => {
  for (const data of [null, false, 0, 1, "true", {}, []]) {
    await assert.rejects(responseClient({ data }).submit(read, signal()), problem("invalid-response"));
  }
  assert.deepEqual(await responseClient({ data: true }).submit(read, signal()), { kind: "read" });
});

test("bare data, conflicting envelopes and malformed JSON cannot confirm a mutation", async () => {
  for (const payload of [null, [], {}, MESSAGE, { data: MESSAGE, error: { code: "FAILED" } }]) {
    await assert.rejects(responseClient(payload, 201).submit(reply, signal()), problem("invalid-response"));
  }
  const broken = createMessagingTransport({ fetchImpl: async () => new Response('{"data":', { status: 201, headers: { "content-type": "application/json" } }) });
  await assert.rejects(broken.submit(reply, signal()), problem("invalid-response"));
  const unreadable = createMessagingTransport({ fetchImpl: async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(unreadable.submit(reply, signal()), problem("invalid-response"));
});

test("non-JSON, missing bodies and invalid declared sizes are refused before buffering", async () => {
  const cases: Record<string, string>[] = [
    { "content-type": "text/html" },
    { "content-type": "application/json", "content-length": "not-a-number" },
    { "content-type": "application/json", "content-length": String(MESSAGING_RESPONSE_MAX_BYTES + 1) },
  ];
  for (const headers of cases) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const client = createMessagingTransport({ fetchImpl: async () => new Response(body, { status: 201, headers }) });
    await assert.rejects(client.submit(reply, signal()), problem("invalid-response"));
    assert.equal(cancelled, true);
  }
  const noBody = createMessagingTransport({ fetchImpl: async () => new Response(null, { headers: { "content-type": "application/json" } }) });
  await assert.rejects(noBody.submit(reply, signal()), problem("invalid-response"));
});

test("chunked oversized responses are cancelled at the byte ceiling rather than fully buffered", async () => {
  let cancelled = false;
  const client = createMessagingTransport({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MESSAGING_RESPONSE_MAX_BYTES + 1)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json", "content-length": "1" } }) });
  await assert.rejects(client.submit(reply, signal()), problem("invalid-response"));
  assert.equal(cancelled, true);
});

test("a legal maximally escaped Chinese message fits the response bound", async () => {
  const value = "读".repeat(20_000);
  const intent = { ...reply, value, payload: JSON.stringify({ body: value }) };
  const text = JSON.stringify({ data: { ...MESSAGE, body: value } }).replaceAll("读", "\\u8bfb");
  assert.ok(new TextEncoder().encode(text).length < MESSAGING_RESPONSE_MAX_BYTES);
  const client = createMessagingTransport({ fetchImpl: async () => new Response(text, { status: 201, headers: { "content-type": "Application/JSON; charset=utf-8" } }) });
  const result = await client.submit(intent, signal());
  assert.ok(result.kind === "reply");
  assert.equal(result.message.body, value);
});

test("HTTP outcomes are explicit and never include upstream messages or private payloads", async () => {
  const cases: [number, string, MessagingProblem][] = [
    [401, "UNAUTHENTICATED", "unauthenticated"], [403, "FORBIDDEN", "missing"],
    [404, "NOT_FOUND", "missing"], [400, "BAD_USER_INPUT", "invalid"],
    [409, "ACCOUNT_CHANGED", "account-changed"], [409, "IDEMPOTENCY_CONFLICT", "conflict"],
    [429, "RATE_LIMITED", "unavailable"], [500, "INTERNAL", "unavailable"], [503, "DOWN", "unavailable"],
  ];
  for (const [status, code, expected] of cases) {
    const client = responseClient({ error: { code, message: "private-original-text token cookie" } }, status);
    await assert.rejects(client.submit(reply, signal()), (error: unknown) => {
      assert.ok(error instanceof MessagingRequestError);
      assert.equal(error.code, expected);
      assert.doesNotMatch(error.message, /private-original-text|token|cookie|A private message/);
      return true;
    });
  }
});

test("a truncated conflict response is unconfirmed, not an invented account-change signal", async () => {
  const client = createMessagingTransport({ fetchImpl: async () => new Response('{"error":', { status: 409, headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.submit(reply, signal()), problem("invalid-response"));
});

test("an aborted parent never starts a request, and abort cancels a pending response body", async () => {
  let calls = 0;
  const aborted = new AbortController();
  aborted.abort();
  const never = createMessagingTransport({ fetchImpl: async () => { calls++; return Response.json({ data: MESSAGE }); } });
  await assert.rejects(never.submit(reply, aborted.signal), problem("cancelled"));
  assert.equal(calls, 0);
  const parent = new AbortController();
  let cancelled = false;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const client = createMessagingTransport({ fetchImpl: async () => {
    entered();
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
  } });
  const pending = client.submit(reply, parent.signal);
  await started;
  parent.abort();
  await assert.rejects(pending, problem("cancelled"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("a deadline bounds even a fetch that ignores abort; no write is silently retried", async () => {
  let calls = 0;
  const client = createMessagingTransport({ timeoutMs: 20, fetchImpl: async () => { calls++; return new Promise<Response>(() => {}); } });
  await assert.rejects(client.submit(reply, signal()), problem("timeout"));
  assert.equal(calls, 1);
  const offline = createMessagingTransport({ fetchImpl: async () => { throw new Error("private connection details"); } });
  await assert.rejects(offline.submit(reply, signal()), problem("unavailable"));
});

test("the same deadline includes a stalled body and cancels its stream", async () => {
  let cancelled = false;
  const client = createMessagingTransport({ timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.submit(reply, signal()), problem("timeout"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("invalid timeout configuration cannot produce an unbounded client", () => {
  for (const timeoutMs of [0, -1, 0.5, Infinity, 300_001]) {
    assert.throws(() => createMessagingTransport({ timeoutMs }), RangeError);
  }
});

test("non-ASCII actor IDs and literal percent/comma/space characters cross the header as one encoded precondition", async () => {
  for (const actorId of ["讀者甲", "reader one", "reader,name", "reader%2Fname"]) {
    const calls: RequestInit[] = [];
    const client = createMessagingTransport({ fetchImpl: async (_path, init) => {
      calls.push(init);
      return Response.json({ data: { ...MESSAGE, senderId: actorId } }, { status: 201 });
    } });
    const result = await client.submit({ ...reply, actorId }, signal());
    assert.equal(new Headers(calls[0].headers).get("x-expected-messaging-actor"), encodeURIComponent(actorId));
    assert.ok(result.kind === "reply");
    assert.equal(result.message.senderId, actorId);
    assert.equal(calls.length, 1);
  }
});
