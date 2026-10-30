import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTIFICATION_ID_PATTERN,
  NOTIFICATIONS_LIMIT,
  handleNotificationReadRequest,
  handleNotificationsReadAllRequest,
  handleNotificationsRequest,
  handleNotificationsUnreadCountRequest,
  notificationReadPath,
  notificationsPath,
  notificationsReadAllPath,
  notificationsUnreadCountPath,
} from "../src/notifications.ts";
import { API_BASE, assertNoStore, json, request, stubFetch } from "./helpers.ts";

/**
 * Notification-inbox proxy contract.
 *
 * The inbox is the only place a reader learns that a work they commented on is
 * going away, so these are the properties that decide whether the notice is
 * actually delivered: the reads attach the HttpOnly cookie as `Authorization`
 * (the browser cannot do it itself), the writes only cross the proxy from our
 * own origin, a notification id is shape-checked before it is forwarded, and
 * every answer is uncacheable — an inbox a shared cache could keep would be a
 * privacy bug, not a performance win.
 */

const NOTIFICATION_ID = "3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44";

function upstream(body: unknown = { data: [] }, status = 200) {
  return stubFetch({ "api/v1/me/notifications": () => json(body, status) });
}

function listRequest(method = "GET", headers: Record<string, string> = {}): Request {
  return request("/api/notifications", { method, headers: { host: "no-wave.test", ...headers } });
}

function countRequest(method = "GET", headers: Record<string, string> = {}): Request {
  return request("/api/notifications/unread-count", { method, headers: { host: "no-wave.test", ...headers } });
}

function readAllRequest(headers: Record<string, string> = {}): Request {
  return request("/api/notifications/read-all", {
    method: "POST",
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
  });
}

function readOneRequest(id: string, headers: Record<string, string> = {}): Request {
  return request(`/api/notifications/${id}/read`, {
    method: "PUT",
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
  });
}

test("the inbox is a no-store read that carries the page limit the API documents", async () => {
  const notice = {
    id: NOTIFICATION_ID,
    eventKey: `article.deleted:article-1:reader-1`,
    payload: JSON.stringify({ type: "article.deleted", articleId: "article-1", purgesAt: "2026-02-01T03:04:05.678Z" }),
    createdAt: "2026-01-02T03:04:05.678Z",
    readAt: null,
  };
  const stub = upstream({ data: [notice] });
  const listed = await handleNotificationsRequest(listRequest(), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(listed.status, 200);
  assertNoStore(listed);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${notificationsPath()}`);
  assert.equal(stub.calls[0]?.init?.method, "GET");
  assert.match(stub.calls[0]?.url ?? "", new RegExp(`limit=${NOTIFICATIONS_LIMIT}(&|$)`));
  assert.deepEqual(await listed.json(), { data: [notice] });

  // Only GET: an inbox is not writable through this path.
  const write = await handleNotificationsRequest(
    listRequest("DELETE"),
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(write.status, 405);
});

test("the unread count is a no-store read of its own endpoint", async () => {
  const stub = upstream({ data: 2 });
  const counted = await handleNotificationsUnreadCountRequest(
    countRequest(),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(counted.status, 200);
  assertNoStore(counted);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${notificationsUnreadCountPath()}`);

  const wrongMethod = await handleNotificationsUnreadCountRequest(
    countRequest("POST"),
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(wrongMethod.status, 405);
});

test("marking every notice read is a body-less POST from our own origin only", async () => {
  const stub = upstream({ data: 3 });
  const marked = await handleNotificationsReadAllRequest(
    readAllRequest(),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(marked.status, 200);
  assertNoStore(marked);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${notificationsReadAllPath()}`);
  assert.equal(stub.calls[0]?.init?.method, "POST");
  assert.equal(stub.calls[0]?.init?.body, undefined, "marking all read carries no body");

  const cross = await handleNotificationsReadAllRequest(
    readAllRequest({ origin: "https://evil.test" }),
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(cross.status, 403);
  assert.equal((await cross.json() as { error: { code: string } }).error.code, "ORIGIN_REJECTED");

});

test("only POST reaches the read-all endpoint", async () => {
  const stub = upstream();
  const response = await handleNotificationsReadAllRequest(
    request("/api/notifications/read-all", { method: "GET", headers: { host: "no-wave.test" } }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 405);
  assert.deepEqual(stub.calls, []);
});

test("marking one notice read checks the origin before the id, and the id at all", async () => {
  const stub = upstream({ data: { id: NOTIFICATION_ID, readAt: "2026-01-03T00:00:00.000Z" } });
  const marked = await handleNotificationReadRequest(
    readOneRequest(NOTIFICATION_ID),
    { id: NOTIFICATION_ID },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(marked.status, 200);
  assertNoStore(marked);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${notificationReadPath(NOTIFICATION_ID)}`);
  assert.equal(stub.calls[0]?.init?.method, "PUT");

  // Anything that is not a UUID is refused here, so a malformed id never
  // reaches the API and cannot be used to probe it.
  assert.equal(NOTIFICATION_ID_PATTERN.test("not-a-uuid"), false);
  const malformed = await handleNotificationReadRequest(
    readOneRequest("not-a-uuid"),
    { id: "not-a-uuid" },
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { error: { code: string } }).error.code, "BAD_USER_INPUT");

  // Order: a cross-origin request is refused for its origin even when the id is
  // also invalid, so the status code cannot be used to learn which ids exist.
  const both = await handleNotificationReadRequest(
    readOneRequest("not-a-uuid", { origin: "https://evil.test" }),
    { id: "not-a-uuid" },
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(both.status, 403);
});
