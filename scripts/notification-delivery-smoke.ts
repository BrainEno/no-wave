import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

type Notification = { eventKey: string; payload: string };
type Actor = { token: string; id: string };
export type NotificationSmokeOptions = {
  apiUrl: string;
  workerUrl?: string;
  timeoutMs?: number;
  deliveryDeadlineMs?: number;
};

function origin(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("Notification smoke requires credential-free HTTP origins.");
  }
  return parsed.origin;
}
function record(value: unknown, step: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${step}: missing response object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, step: string): string {
  if (typeof value !== "string" || !value || value.length > 16_384) throw new Error(`${step}: missing response identifier.`);
  return value;
}

/** Only public HTTP is used: the same test runs outside a container or against
 * a developer's disposable stack. No database access, fake drain or test-only
 * delivery hook can turn a container that merely starts into a passing result.
 * Errors name fixed steps/statuses, never bodies, identities or bearer tokens. */
export async function runNotificationDeliverySmoke({ apiUrl, workerUrl, timeoutMs = 30_000, deliveryDeadlineMs = 5000 }: NotificationSmokeOptions) {
  const api = origin(apiUrl);
  const worker = workerUrl === undefined ? null : origin(workerUrl);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("Invalid notification smoke timeout.");
  if (!Number.isInteger(deliveryDeadlineMs) || deliveryDeadlineMs < 100 || deliveryDeadlineMs > timeoutMs) throw new Error("Invalid notification delivery deadline.");
  const started = performance.now();
  const deadline = started + timeoutMs;
  const nonce = randomUUID();
  const privateBody = `notification-smoke-private-${nonce}`;
  const observedSecrets: string[] = [privateBody];
  let checks = 0;

  async function request(step: string, base: string, path: string, {
    method = "GET", body, token, status = 200, key,
  }: { method?: string; body?: unknown; token?: string; status?: number; key?: string } = {}): Promise<unknown> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`${step}: total smoke deadline exceeded.`);
    let response: Response;
    try {
      response = await fetch(base + path, { method, redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(5000, remaining)))),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error(`${step}: HTTP request failed or timed out.`); }
    if (response.status !== status) {
      await response.body?.cancel();
      throw new Error(`${step}: expected HTTP ${status}, received ${response.status}.`);
    }
    try { return await response.json() as unknown; }
    catch { throw new Error(`${step}: invalid JSON response.`); }
  }
  const data = async (step: string, path: string, options: Parameters<typeof request>[3] = {}) =>
    record(await request(step, api, "/api/v1" + path, options), step).data;
  async function register(label: string): Promise<Actor> {
    const session = record(await data("register", "/auth/register", { method: "POST", status: 201,
      body: { email: `container-${label}-${nonce}@example.test`, password: "container-smoke-fixture-password" } }), "register");
    const token = text(session.accessToken, "register");
    observedSecrets.push(token);
    const me = record(await data("current actor", "/me", { token }), "current actor");
    return { token, id: text(me.id, "current actor") };
  }
  async function inbox(actor: Actor): Promise<Notification[]> {
    const value = await data("read inbox", "/me/notifications?limit=20", { token: actor.token });
    if (!Array.isArray(value)) throw new Error("Read inbox: expected notification rows.");
    return value.map(item => {
      const row = record(item, "notification");
      return { eventKey: text(row.eventKey, "notification"), payload: text(row.payload, "notification") };
    });
  }
  function privateProbe(value: unknown): void {
    const encoded = JSON.stringify(value);
    if (observedSecrets.some(secret => encoded.includes(secret))) throw new Error("Operational probes disclosed private message or identity data.");
  }

  if (worker) {
    const live = record(await request("worker liveness", worker, "/health?source=container-smoke"), "worker liveness");
    const ready = record(await request("worker readiness", worker, "/ready?source=container-smoke"), "worker readiness");
    if (live.service !== "notification-worker" || ready.service !== "notification-worker" || ready.status !== "ready") {
      throw new Error("The worker health origin must be the independent ready notification-worker role.");
    }
    privateProbe(live); privateProbe(ready);
    checks += 2;
  }
  const sender = await register("sender");
  const recipient = await register("recipient");
  const outsider = await register("outsider");
  const conversation = record(await data("create conversation", "/conversations", { method: "POST", status: 201, token: sender.token,
    key: randomUUID(), body: { participantIds: [recipient.id] } }), "create conversation");
  const conversationId = text(conversation.id, "create conversation");
  const messageKey = randomUUID();
  const path = `/conversations/${encodeURIComponent(conversationId)}/messages`;
  const send = () => data("commit message", path, { method: "POST", status: 201, token: sender.token, key: messageKey, body: { body: privateBody } });
  const message = record(await send(), "commit message");
  const committedAt = performance.now();
  const messageId = text(message.id, "commit message");
  const replayed = record(await send(), "replay message");
  if (replayed.id !== messageId) throw new Error("An identical idempotent retry created a second message.");
  checks += 2;
  const expectedKey = `message:${messageId}`;
  const deliveryDeadline = Math.min(deadline, committedAt + deliveryDeadlineMs);
  let delivered: Notification[] = [];
  while (performance.now() < deliveryDeadline) {
    delivered = (await inbox(recipient)).filter(row => row.eventKey === expectedKey);
    if (delivered.length > 0) break;
    await delay(Math.min(100, Math.max(1, deliveryDeadline - performance.now())));
  }
  const deliveryMs = Math.round(performance.now() - committedAt);
  if (delivered.length !== 1 || performance.now() > deliveryDeadline) throw new Error("The committed message did not produce exactly one recipient notification within the delivery deadline.");
  let payload: Record<string, unknown>;
  try { payload = record(JSON.parse(delivered[0]!.payload) as unknown, "notification payload"); }
  catch { throw new Error("The delivered notification contains an invalid payload."); }
  if (payload.type !== "message.created" || payload.messageId !== messageId || payload.conversationId !== conversationId || payload.senderId !== sender.id) {
    throw new Error("The recipient notification does not identify the committed message and its authorized sender.");
  }
  if ((await inbox(sender)).some(row => row.eventKey === expectedKey)) throw new Error("The sender received their own message notification.");
  if ((await inbox(outsider)).some(row => row.eventKey === expectedKey)) throw new Error("A nonparticipant received a private notification.");
  await data("anonymous inbox denied", "/me/notifications", { status: 401 });
  checks += 4;
  const apiReady = await request("API readiness", api, "/ready?source=container-smoke");
  privateProbe(apiReady);
  if (record(apiReady, "API readiness").status !== "ready") throw new Error("API readiness regressed after notification delivery.");
  if (worker) privateProbe(await request("worker remains ready", worker, "/ready?source=after-delivery"));
  checks += worker ? 2 : 1;
  return { event: "notification_delivery_smoke_passed", checks, deliveryMs, durationMs: Math.round(performance.now() - started) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runNotificationDeliverySmoke({ apiUrl: process.env.SMOKE_API_URL ?? "http://127.0.0.1:4000",
    ...(process.env.SMOKE_WORKER_URL ? { workerUrl: process.env.SMOKE_WORKER_URL } : {}) })
    .then(result => console.log(JSON.stringify(result)), error => {
      console.error(JSON.stringify({ event: "notification_delivery_smoke_failed", errorMessage: error instanceof Error ? error.message : "Notification smoke failed." }));
      process.exitCode = 1;
    });
}
