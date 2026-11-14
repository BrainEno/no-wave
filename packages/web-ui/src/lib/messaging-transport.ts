import { CONVERSATION_ID_PATTERN, MESSAGE_BODY_MAX_CHARS, MESSAGING_EXPECTED_ACTOR_HEADER, isUsableIdempotencyKey, readLimitedStream, resolveUpstreamTimeoutMs, UpstreamTimeoutError, withUpstreamDeadline } from "@bot-thk/web-http";

export type MessagingProblem = "unverified" | "unauthenticated" | "account-changed" | "conflict" | "invalid" | "too-long" | "changed" | "missing" | "unavailable" | "invalid-response" | "timeout" | "cancelled";
export class MessagingRequestError extends Error {
  readonly code: MessagingProblem;
  constructor(code: MessagingProblem) { super(`Messaging request failed: ${code}.`); this.name = "MessagingRequestError"; this.code = code; }
}
export type MessagingTarget = Readonly<{ kind: "start" } | { kind: "reply" | "read"; conversationId: string }>;
export type MessagingIntent = Readonly<{
  target: MessagingTarget;
  actorId: string;
  value: string;
  key: string | null;
  payload: string | undefined;
}>;
export type SentMessage = Readonly<{ id: string; conversationId: string; senderId: string; body: string; createdAt: string }>;
export type MessagingReceipt = Readonly<{ kind: "start"; conversationId: string } | { kind: "reply"; message: SentMessage } | { kind: "read" }>;
export type MessagingTransport = {
  actor(signal: AbortSignal): Promise<string>;
  submit(intent: MessagingIntent, signal: AbortSignal): Promise<MessagingReceipt>;
};
export type MessagingFetch = (path: string, init: RequestInit) => Promise<Response>;
export const MESSAGING_RESPONSE_MAX_BYTES = 256 * 1024;
const invalidResponse = () => new MessagingRequestError("invalid-response");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The browser can only restrict a verified actor; this value never authenticates one. */
export function isMessagingActor(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 300 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
function validIntent(intent: MessagingIntent): boolean {
  if (!isMessagingActor(intent.actorId)) return false;
  const target = intent.target;
  if (target.kind !== "start" && !CONVERSATION_ID_PATTERN.test(target.conversationId)) return false;
  if (target.kind === "read") return intent.key === null && intent.payload === undefined && intent.value === "";
  if (!isUsableIdempotencyKey(intent.key) || /[\u0000-\u001f\u007f]/u.test(intent.key)) return false;
  if (target.kind === "start") return isMessagingActor(intent.value) && intent.value !== intent.actorId && intent.payload === JSON.stringify({ participantIds: [intent.value] });
  return target.kind === "reply" && intent.value.length > 0 && intent.value.trim() === intent.value && intent.value.length <= MESSAGE_BODY_MAX_CHARS && intent.payload === JSON.stringify({ body: intent.value });
}
function receiptFor(intent: MessagingIntent, value: unknown): MessagingReceipt {
  if (intent.target.kind === "read") {
    if (value !== true) throw invalidResponse();
    return Object.freeze({ kind: "read" });
  }
  if (!record(value) || typeof value.id !== "string" || !CONVERSATION_ID_PATTERN.test(value.id)) throw invalidResponse();
  if (intent.target.kind === "start") {
    const participants = value.participantIds;
    if (!Array.isArray(participants) || participants.length < 2 || participants.length > 21 || !participants.every(isMessagingActor) ||
        new Set(participants).size !== participants.length || !participants.includes(intent.actorId) || !participants.includes(intent.value)) throw invalidResponse();
    return Object.freeze({ kind: "start", conversationId: value.id });
  }
  if (value.conversationId !== intent.target.conversationId || value.senderId !== intent.actorId || value.body !== intent.value || !instant(value.createdAt)) throw invalidResponse();
  return Object.freeze({ kind: "reply", message: Object.freeze({ id: value.id, conversationId: intent.target.conversationId,
    senderId: intent.actorId, body: intent.value, createdAt: value.createdAt }) });
}

/** Bounded private JSON, with no automatic write retries and no durable client cache. */
export function createMessagingTransport({ fetchImpl = fetch, timeoutMs = 8000 }: { fetchImpl?: MessagingFetch; timeoutMs?: number } = {}): MessagingTransport {
  const timeout = resolveUpstreamTimeoutMs(timeoutMs);
  async function request(path: string, parent: AbortSignal, intent?: MessagingIntent): Promise<unknown> {
    try {
      parent.throwIfAborted();
      return await withUpstreamDeadline(timeout, async (deadline) => {
        const signal = AbortSignal.any([parent, deadline]);
        signal.throwIfAborted();
        let onAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new MessagingRequestError("cancelled"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const operation = (async () => {
          const headers = new Headers({ accept: "application/json" });
          if (intent) {
            headers.set(MESSAGING_EXPECTED_ACTOR_HEADER, encodeURIComponent(intent.actorId));
            if (intent.key !== null) headers.set("idempotency-key", intent.key);
            if (intent.payload !== undefined) headers.set("content-type", "application/json");
          }
          const response = await fetchImpl(path, { method: intent ? intent.target.kind === "read" ? "PUT" : "POST" : "GET",
            headers, credentials: "same-origin", cache: "no-store", redirect: "error", signal,
            ...(intent?.payload === undefined ? {} : { body: intent.payload }) });
          if (signal.aborted || !response.ok && response.status !== 409) {
            void response.body?.cancel().catch(() => {});
            signal.throwIfAborted();
            throw new MessagingRequestError(response.status === 401 ? "unauthenticated" : response.status === 403 || response.status === 404 ? "missing" : response.status === 400 ? "invalid" : "unavailable");
          }
          const length = response.headers.get("content-length");
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body ||
              length !== null && (!/^\d+$/.test(length) || Number(length) > MESSAGING_RESPONSE_MAX_BYTES)) {
            void response.body?.cancel().catch(() => {});
            throw invalidResponse();
          }
          const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal });
          const body = await readLimitedStream(stream, MESSAGING_RESPONSE_MAX_BYTES);
          signal.throwIfAborted();
          if (!body.ok) throw invalidResponse();
          let envelope: unknown;
          try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)) as unknown; }
          catch { throw invalidResponse(); }
          if (!record(envelope)) throw invalidResponse();
          if (response.status === 409) {
            throw new MessagingRequestError(record(envelope.error) && envelope.error.code === "ACCOUNT_CHANGED" ? "account-changed" : "conflict");
          }
          if (!("data" in envelope) || envelope.error !== null && envelope.error !== undefined) throw invalidResponse();
          return envelope.data;
        })();
        try { return await Promise.race([operation, aborted]); }
        finally { signal.removeEventListener("abort", onAbort); }
      });
    } catch (error: unknown) {
      if (parent.aborted) throw new MessagingRequestError("cancelled");
      if (error instanceof UpstreamTimeoutError) throw new MessagingRequestError("timeout");
      if (error instanceof MessagingRequestError) throw error;
      throw new MessagingRequestError("unavailable");
    }
  }
  return Object.freeze({
    async actor(signal: AbortSignal) {
      const data = await request("/api/authoring/session", signal);
      if (!record(data) || !isMessagingActor(data.id)) throw invalidResponse();
      return data.id;
    },
    async submit(intent: MessagingIntent, signal: AbortSignal) {
      if (!validIntent(intent)) throw new MessagingRequestError("invalid");
      const target = intent.target;
      const path = target.kind === "start" ? "/api/authoring/inbox" : `/api/authoring/inbox/${encodeURIComponent(target.conversationId)}/${target.kind === "read" ? "read" : "messages"}`;
      return receiptFor(intent, await request(path, signal, intent));
    },
  });
}
