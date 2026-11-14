import { readLimitedStream, resolveUpstreamTimeoutMs, UpstreamTimeoutError, withUpstreamDeadline } from "@bot-thk/web-http";
import { isNotificationItem, type NotificationItem } from "./chrome.ts";
import { parseNotificationPage, type NotificationPage } from "./notification-pages.ts";

export const NOTIFICATION_BODY_LIMIT = 1024 * 1024;
export type NotificationProblem = "unauthenticated" | "unavailable" | "invalid-response" | "timeout" | "cancelled" | "stalled-page";
export class NotificationRequestError extends Error {
  readonly code: NotificationProblem;
  constructor(code: NotificationProblem) { super(`Notification request failed: ${code}.`); this.name = "NotificationRequestError"; this.code = code; }
}
export type NotificationTransport = {
  count(signal: AbortSignal): Promise<number>;
  page(cursor: string | null, signal: AbortSignal): Promise<NotificationPage>;
  mark(id: string | undefined, signal: AbortSignal): Promise<NotificationItem | number>;
};
type NotificationFetch = (url: string, init: RequestInit) => Promise<Response>;
const ROOT = "/api/authoring/notifications";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => new NotificationRequestError("invalid-response");
const total = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function instant(value: string): boolean {
  try { return new Date(value).toISOString() === value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value); } catch { return false; }
}
function item(value: unknown): value is NotificationItem {
  return isNotificationItem(value) && ID.test(value.id) && value.eventKey.trim().length > 0 && value.eventKey.length <= 512 &&
    instant(value.createdAt) && (value.readAt === null || instant(value.readAt));
}

/** A strict browser boundary, not a replacement for the API's authorization or read-state rules. */
export function createNotificationTransport({ fetchImpl = fetch, timeoutMs = 8000 }: {
  fetchImpl?: NotificationFetch; timeoutMs?: number;
} = {}): NotificationTransport {
  const timeout = resolveUpstreamTimeoutMs(timeoutMs);
  async function request(path: string, method: "GET" | "PUT" | "POST", parent: AbortSignal): Promise<unknown> {
    try {
      parent.throwIfAborted();
      return await withUpstreamDeadline(timeout, async (deadline) => {
        const signal = AbortSignal.any([parent, deadline]);
        signal.throwIfAborted();
        let onAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new NotificationRequestError("cancelled"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const operation = (async () => {
          const response = await fetchImpl(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
            headers: { accept: "application/json" }, signal });
          if (signal.aborted || !response.ok) {
            void response.body?.cancel().catch(() => {});
            signal.throwIfAborted();
            throw new NotificationRequestError(response.status === 401 ? "unauthenticated" : "unavailable");
          }
          const length = response.headers.get("content-length");
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body ||
              (length !== null && (!/^\d+$/.test(length) || Number(length) > NOTIFICATION_BODY_LIMIT))) {
            void response.body?.cancel().catch(() => {});
            throw invalid();
          }
          // Reuse the shared byte ceiling; the signal-aware pipe also cancels
          // a reader waiting for a body chunk, not just the initial fetch.
          const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal });
          const body = await readLimitedStream(stream, NOTIFICATION_BODY_LIMIT);
          signal.throwIfAborted();
          if (!body.ok) throw invalid();
          let decoded: unknown;
          try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)) as unknown; }
          catch { throw invalid(); }
          if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded) || !("data" in decoded) ||
              ("error" in decoded && decoded.error !== null && decoded.error !== undefined)) throw invalid();
          return decoded.data;
        })();
        try { return await Promise.race([operation, aborted]); }
        finally { signal.removeEventListener("abort", onAbort); }
      });
    } catch (error) {
      if (parent.aborted) throw new NotificationRequestError("cancelled");
      if (error instanceof UpstreamTimeoutError) throw new NotificationRequestError("timeout");
      if (error instanceof NotificationRequestError) throw error;
      throw new NotificationRequestError("unavailable");
    }
  }
  return Object.freeze({
    async count(signal: AbortSignal) {
      const value = await request(`${ROOT}/unread-count`, "GET", signal);
      if (!total(value)) throw invalid();
      return value;
    },
    async page(cursor: string | null, signal: AbortSignal) {
      if (cursor !== null && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw invalid();
      const query = new URLSearchParams({ limit: "50" });
      if (cursor !== null) query.set("cursor", cursor);
      const value = await request(`${ROOT}?${query}`, "GET", signal);
      if (!Array.isArray(value) || !value.every(item) || new Set(value.map((entry: NotificationItem) => entry.id)).size !== value.length) throw invalid();
      try { return parseNotificationPage({ data: value }); } catch { throw invalid(); }
    },
    async mark(id: string | undefined, signal: AbortSignal) {
      if (id !== undefined && !ID.test(id)) throw invalid();
      const value = await request(id === undefined ? `${ROOT}/read-all` : `${ROOT}/${encodeURIComponent(id)}/read`, id === undefined ? "POST" : "PUT", signal);
      if (id === undefined ? !total(value) : !item(value) || value.id !== id || value.readAt === null) throw invalid();
      return value as NotificationItem | number;
    },
  });
}
