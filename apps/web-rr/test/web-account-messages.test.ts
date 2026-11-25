/**
 * The inbox, devices, password and address changes, conversations and mark-read routes.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MOCK_CREDENTIALS, MOCK_DELETED_ARTICLE_ID, MOCK_DEVICE_IDS, MOCK_NOTIFICATION, MOCK_TOKENS, resetMockDevices, resetMockNotifications } from "../mocks/rest-api.ts";
import { registerPublicWebApp, DESK_COOKIE, baseUrl, del, get, mockApi, post, put } from "./support/web-behavior-harness.ts";

registerPublicWebApp();

/**
 * The notification inbox.
 *
 * Deleting a work eventually deletes the comments under it, and those are other
 * people's words, so the API writes each commenter a notice naming the date the
 * sweep runs. A notice nobody can read is a ledger entry rather than a message,
 * and this is where it becomes readable: the same four endpoints, served by the
 * same shared handler, in both frameworks.
 */
test("the inbox is private, no-store and API-backed", async () => {
  const anonymous = await get("/api/authoring/notifications");
  assert.equal(anonymous.status, 401, "an inbox belongs to a signed-in reader");

  mockApi.resetRequests();
  const list = await get("/api/authoring/notifications", { cookie: DESK_COOKIE });
  assert.equal(list.status, 200);
  // An inbox a shared cache could keep would be a privacy bug, not a win.
  assert.match(list.headers.get("cache-control") ?? "", /no-store/);
  const notices = (JSON.parse(list.body) as { data: Array<{ id: string; payload: string }> }).data;
  assert.equal(notices[0]?.id, MOCK_NOTIFICATION.id);
  // The payload is a JSON string on the wire, and what it carries is the two
  // facts the reader can act on: which work, and when the sweep runs.
  assert.deepEqual(JSON.parse(notices[0]?.payload ?? "{}"), {
    type: "article.deleted",
    articleId: MOCK_DELETED_ARTICLE_ID,
    purgesAt: (JSON.parse(MOCK_NOTIFICATION.payload) as { purgesAt: string }).purgesAt,
  });
  assert.ok(
    mockApi.requests().some((request) => request.includes("limit=50")),
    `the upstream call must carry the documented page limit: ${mockApi.requests().join(", ")}`,
  );
});

test("marking a notice read, one at a time or all at once, is the API's own answer", async () => {
  resetMockNotifications();
  const unread = await get("/api/authoring/notifications/unread-count", { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(unread.body) as { data: number }).data, 1);

  const marked = await put(`/api/authoring/notifications/${MOCK_NOTIFICATION.id}/read`, "{}", { cookie: DESK_COOKIE });
  assert.equal(marked.status, 200);
  assert.ok((JSON.parse(marked.body) as { data: { readAt: string | null } }).data.readAt);

  const after = await get("/api/authoring/notifications/unread-count", { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(after.body) as { data: number }).data, 0, "the count follows the mark");

  // A notice that is already read is not marked twice, and an unknown id is not
  // distinguishable from someone else's notice by its status.
  const again = await put(`/api/authoring/notifications/${MOCK_NOTIFICATION.id}/read`, "{}", { cookie: DESK_COOKIE });
  assert.equal(again.status, 404);

  resetMockNotifications();
  const all = await post("/api/authoring/notifications/read-all", "{}", { cookie: DESK_COOKIE });
  assert.equal(all.status, 200);
  assert.equal((JSON.parse(all.body) as { data: number }).data, 1, "read-all reports what it marked");
  const afterAll = await get("/api/authoring/notifications/unread-count", { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(afterAll.body) as { data: number }).data, 0);
});

test("the inbox's writes are origin-checked, and a malformed id never reaches the API", async () => {
  mockApi.resetRequests();
  const crossAll = await post("/api/authoring/notifications/read-all", "{}", {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(crossAll.status, 403);
  assert.match(crossAll.body, /ORIGIN_REJECTED/);
  const crossOne = await put(`/api/authoring/notifications/${MOCK_NOTIFICATION.id}/read`, "{}", {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(crossOne.status, 403);
  assert.deepEqual(mockApi.requests(), [], "a cross-origin write must not be forwarded at all");

  const malformed = await put("/api/authoring/notifications/not-a-uuid/read", "{}", { cookie: DESK_COOKIE });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body, /BAD_USER_INPUT/);

  // Order: origin first, so a cross-origin caller cannot use the status code to
  // learn which notification ids exist.
  const both = await put("/api/authoring/notifications/not-a-uuid/read", "{}", {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(both.status, 403);

  const anonymous = await put(`/api/authoring/notifications/${MOCK_NOTIFICATION.id}/read`, "{}");
  assert.equal(anonymous.status, 401);
});

/**
 * `GET|DELETE /api/authoring/sessions` and `DELETE /api/authoring/sessions/:id`.
 *
 * The interesting part is not that a list comes back — it is that the proxy
 * carries no policy of its own beyond the method, the exact-Origin check on
 * writes and the cookie's token, and that the *sparing* stays upstream: which
 * device "end the others" keeps is the API's decision, made from the token, and
 * a proxy that tried to decide it would have to guess. So the assertions are
 * about the wiring and the pass-through, and the rules themselves stay API
 * tests.
 */
test("the device list reaches the API with the cookie's token, and only as a GET", async () => {
  resetMockDevices();
  const session = { cookie: `nw_access=${MOCK_TOKENS.accessToken}; nw_refresh=${MOCK_TOKENS.refreshToken}` };

  const signedOut = await get("/api/authoring/sessions");
  assert.equal(signedOut.status, 401, "without a session there are no devices to list");

  const listed = await get("/api/authoring/sessions", session);
  assert.equal(listed.status, 200);
  assert.match(listed.headers.get("cache-control") ?? "", /no-store/, "a device list is private");
  assert.match(listed.body, new RegExp(MOCK_DEVICE_IDS.current));
  assert.match(listed.body, /"current":true/, "one of them is the device asking");
  assert.match(listed.body, /"current":false/, "and one is not");

  const write = await post("/api/authoring/sessions", "{}", session);
  assert.ok([404, 405].includes(write.status), "the collection is not a POST target");
});

test("ending one device, and ending the others, are same-origin DELETEs whose answers pass through", async () => {
  resetMockDevices();
  const session = { cookie: `nw_access=${MOCK_TOKENS.accessToken}; nw_refresh=${MOCK_TOKENS.refreshToken}` };

  const foreign = await del(`/api/authoring/sessions/${MOCK_DEVICE_IDS.other}`, { ...session, origin: "https://attacker.example" });
  assert.equal(foreign.status, 403);
  assert.match(foreign.body, /ORIGIN_REJECTED/);

  const ended = await del(`/api/authoring/sessions/${MOCK_DEVICE_IDS.other}`, session);
  assert.equal(ended.status, 200);
  assert.match(ended.body, /"ok":true/);

  const again = await del(`/api/authoring/sessions/${MOCK_DEVICE_IDS.other}`, session);
  assert.equal(again.status, 404, "ending an ended device is not a second ending");

  // The list proves it: one device, the one that asked.
  const listed = await get("/api/authoring/sessions", session);
  assert.match(listed.body, /"current":true/);
  assert.doesNotMatch(listed.body, /"current":false/);

  resetMockDevices();
  const endedOthers = await del("/api/authoring/sessions", session);
  assert.equal(endedOthers.status, 200);
  assert.match(endedOthers.body, /"revokedSessions":1/, "the answer says how many devices were signed out");
  const after = await get("/api/authoring/sessions", session);
  assert.doesNotMatch(after.body, new RegExp(MOCK_DEVICE_IDS.other), "the other device is gone");
  assert.match(after.body, new RegExp(MOCK_DEVICE_IDS.current), "the one that asked is spared");
  resetMockDevices();
});

/**
 * `PUT /api/authoring/password`.
 *
 * The route is a thin adapter over the shared `web-http` handler, so what these
 * assertions prove is the adapter: the path is wired, the method and the
 * exact-Origin check are the shared one's, the cookie's token reaches the API,
 * and the answer is passed through with the private cache policy intact. The
 * rules themselves live in the API and are tested there.
 */
test("a password change reaches the API with the cookie's token, and only as a same-origin PUT", async () => {
  const session = { cookie: `nw_access=${MOCK_TOKENS.accessToken}; nw_refresh=${MOCK_TOKENS.refreshToken}` };

  const signedOut = await put(
    "/api/authoring/password",
    JSON.stringify({ currentPassword: MOCK_CREDENTIALS.password, newPassword: "a-brand-new-password" }),
  );
  assert.equal(signedOut.status, 401, "without a session there is nothing to change");

  const changed = await put(
    "/api/authoring/password",
    JSON.stringify({ currentPassword: MOCK_CREDENTIALS.password, newPassword: "a-brand-new-password" }),
    session,
  );
  assert.equal(changed.status, 200);
  assert.match(changed.headers.get("cache-control") ?? "", /no-store/);
  assert.match(changed.body, /"revokedSessions":2/, "the answer says how many other devices were signed out");

  const foreign = await put(
    "/api/authoring/password",
    JSON.stringify({ currentPassword: MOCK_CREDENTIALS.password, newPassword: "a-brand-new-password" }),
    { ...session, origin: "https://attacker.example" },
  );
  assert.equal(foreign.status, 403);
  assert.match(foreign.body, /ORIGIN_REJECTED/);

  // A password is never readable. React Router answers a resource route that
  // exports only an action, so the refusal happens before the shared handler is
  // reached; that handler's own method contract — 405 for anything that is not
  // a PUT — is asserted in `web-http`.
  const read = await get("/api/authoring/password", session);
  assert.ok(read.status >= 400 && read.status < 500, "a GET must never reach the API");
});

/**
 * `PUT /api/authoring/email`.
 *
 * The adapter's job is the same one the password route has: wire the path, keep
 * the shared handler's method and Origin rules, and pass the answer through.
 * The one extra thing worth proving end to end is that a *conflict* survives
 * the proxy as a 409 and not as a generic failure — the account page says
 * something different for "that address is taken" than for "try again".
 */
test("an address change reaches the API with the cookie's token, and a taken address is a conflict", async () => {
  const session = { cookie: `nw_access=${MOCK_TOKENS.accessToken}; nw_refresh=${MOCK_TOKENS.refreshToken}` };
  const move = (email: string) => JSON.stringify({ password: MOCK_CREDENTIALS.password, email });

  const signedOut = await put("/api/authoring/email", move("moved@example.test"));
  assert.equal(signedOut.status, 401, "without a session the address cannot be moved");

  const changed = await put("/api/authoring/email", move("moved@example.test"), session);
  assert.equal(changed.status, 200);
  assert.match(changed.headers.get("cache-control") ?? "", /no-store/);
  assert.match(changed.body, /"email":"moved@example.test"/);
  assert.match(changed.body, /"emailVerifiedAt":null/, "the new address carries no proof of its own yet");

  const taken = await put("/api/authoring/email", move("taken@example.test"), session);
  assert.equal(taken.status, 409);
  // The code, not just the status: a form says different things for "that
  // address is taken" and for a conflict with no next step.
  assert.match(taken.body, /EMAIL_TAKEN/);

  const foreign = await put("/api/authoring/email", move("moved@example.test"), {
    ...session,
    origin: "https://attacker.example",
  });
  assert.equal(foreign.status, 403);
  assert.match(foreign.body, /ORIGIN_REJECTED/);
});

test("conversation write routes enforce key and origin before reaching the API", async () => {
  const conversation = "c81407b1-4680-469d-9de4-2c34f042081c";
  for (const [path, body] of [
    ["/api/inbox", JSON.stringify({ participantIds: ["reader"] })],
    ["/api/authoring/inbox", JSON.stringify({ participantIds: ["reader"] })],
    [`/api/inbox/${conversation}/messages`, JSON.stringify({ body: "hello" })],
    [`/api/authoring/inbox/${conversation}/messages`, JSON.stringify({ body: "hello" })],
  ]) {
    mockApi.resetRequests();
    const noKey = await post(path, body, { cookie: DESK_COOKIE });
    assert.equal(noKey.status, 400, path);
    assert.match(noKey.body, /Idempotency-Key/);
    const cross = await post(path, body, { cookie: DESK_COOKIE, origin: "https://attacker.example", "idempotency-key": "key" });
    assert.equal(cross.status, 403, path);
    assert.match(cross.body, /ORIGIN_REJECTED/);
    assert.deepEqual(mockApi.requests(), [], "invalid requests must not reach the API");
    // The mock does not implement conversations. A 404 from its fallback proves
    // that this particular route was registered and did forward the valid write.
    const valid = await post(path, body, { cookie: DESK_COOKIE, "idempotency-key": "key" });
    assert.equal(valid.status, 404, path);
    assert.match(valid.body, /No mock route/);
    assert.match(valid.headers.get("cache-control") ?? "", /no-store/);
    assert.ok(mockApi.requests().some((request) => request.includes("/api/v1/conversations")));
  }
});

test("login and message writes accept the browser origin behind TLS termination", async () => {
  // Node's fetch uses the URL authority for Host; only the public scheme differs
  // from the plain HTTP hop between the TLS edge and this process.
  const proxy = { origin: baseUrl.replace(/^http:/, "https:"), "x-forwarded-proto": "https" };
  const login = await post("/api/auth/login", JSON.stringify(MOCK_CREDENTIALS), proxy);
  assert.equal(login.status, 200);
  assert.ok(login.headers.getSetCookie().some((cookie) => /nw_access=.*; Secure/.test(cookie)));
  const body = JSON.stringify({ participantIds: ["reader"] });
  const valid = await post("/api/authoring/inbox", body, { ...proxy, cookie: DESK_COOKIE, "idempotency-key": "key" });
  assert.equal(valid.status, 404, "the origin was accepted and the mock API's fallback answered");
  assert.match(valid.body, /No mock route/);
  const cross = await post("/api/authoring/inbox", body, { ...proxy, origin: "https://attacker.example", "idempotency-key": "key" });
  assert.equal(cross.status, 403);
  const downgrade = await post("/api/authoring/inbox", body, { ...proxy, origin: baseUrl, "idempotency-key": "key" });
  assert.equal(downgrade.status, 403);

  const markPath = "/api/authoring/inbox/c81407b1-4680-469d-9de4-2c34f042081c/read";
  const mark = await put(markPath, "", { ...proxy, cookie: DESK_COOKIE });
  assert.equal(mark.status, 404, "the TLS origin was accepted and the mock API answered");
  assert.match(mark.body, /No mock route/);
  const crossMark = await put(markPath, "", { ...proxy, origin: "https://attacker.example", cookie: DESK_COOKIE });
  assert.equal(crossMark.status, 403);
  const downgradeMark = await put(markPath, "", { ...proxy, origin: baseUrl, cookie: DESK_COOKIE });
  assert.equal(downgradeMark.status, 403);
});

test("mark-read routes enforce their verb, origin and id before forwarding", async () => {
  const conversation = "c81407b1-4680-469d-9de4-2c34f042081c";
  for (const path of [`/api/inbox/${conversation}/read`, `/api/authoring/inbox/${conversation}/read`]) {
    mockApi.resetRequests();
    const getResponse = await get(path, { cookie: DESK_COOKIE });
    assert.equal(getResponse.status, 405, path);
    assert.match(getResponse.body, /METHOD_NOT_ALLOWED/);
    const postResponse = await post(path, "", { cookie: DESK_COOKIE });
    assert.equal(postResponse.status, 405, path);
    const cross = await put(path, "", { cookie: DESK_COOKIE, origin: "https://attacker.example" });
    assert.equal(cross.status, 403, path);
    assert.match(cross.body, /ORIGIN_REJECTED/);
    assert.deepEqual(mockApi.requests(), []);
    const valid = await put(path, "", { cookie: DESK_COOKIE });
    assert.equal(valid.status, 404, "the mock API's fallback, not an unregistered route");
    assert.match(valid.body, /No mock route/);
    assert.match(valid.headers.get("cache-control") ?? "", /no-store/);
    assert.ok(mockApi.requests().some((request) => request.includes(`/api/v1/conversations/${conversation}/read`)));
  }
});
