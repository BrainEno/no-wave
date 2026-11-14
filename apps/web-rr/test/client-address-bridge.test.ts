import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BRIDGE_PASSWORD, BRIDGE_SECRET, EDGE_PEER, FIRST_CLIENT, SECOND_CLIENT, callFrom, registerClient, startClientAddressStack, startEdge, type ViewEnvelope } from "./support/client-address-stack.ts";

test("different real TCP clients each add one anonymous view through the production BFF", async (t) => {
  const stack = await startClientAddressStack();
  t.after(() => stack.close());
  const first = await callFrom(stack.origin, FIRST_CLIENT, stack.viewPath);
  assert.equal(first.status, 200);
  assert.deepEqual((JSON.parse(first.text) as ViewEnvelope).data, { counted: true, viewCount: 1 });
  const second = await callFrom(stack.origin, SECOND_CLIENT, stack.viewPath);
  assert.equal(second.status, 200);
  assert.deepEqual((JSON.parse(second.text) as ViewEnvelope).data, { counted: true, viewCount: 2 });
  const repeat = await callFrom(stack.origin, FIRST_CLIENT, stack.viewPath);
  assert.equal(repeat.status, 200);
  assert.deepEqual((JSON.parse(repeat.text) as ViewEnvelope).data, { counted: false, viewCount: 2 });
  const persisted = await stack.store.getPublishedArticle({ slug: stack.slug, locale: "en" });
  assert.equal(persisted?.viewCount, 2);
  assert.match(first.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(first.headers.get("x-nw-client-address"), null);
  assert.equal(first.headers.get("x-nw-client-address-proof"), null);
  assert.equal(first.text.includes(BRIDGE_SECRET), false);
});

test("changing every browser-supplied address header cannot mint another anonymous reader", async (t) => {
  const stack = await startClientAddressStack();
  t.after(() => stack.close());
  const first = await callFrom(stack.origin, FIRST_CLIENT, stack.viewPath);
  assert.equal((JSON.parse(first.text) as ViewEnvelope).data.counted, true);
  for (const fake of ["198.51.100.40", "2001:db8::99", "198.51.100.41, 198.51.100.42"]) {
    const result = await callFrom(stack.origin, FIRST_CLIENT, stack.viewPath, { headers: {
      "x-forwarded-for": fake, "x-real-ip": fake, forwarded: "for=198.51.100.44",
      "x-nw-client-address": "198.51.100.45", "x-nw-client-address-proof": "v1.1.invalid",
    } });
    assert.equal(result.status, 200);
    assert.deepEqual((JSON.parse(result.text) as ViewEnvelope).data, { counted: false, viewCount: 1 });
    assert.equal(result.headers.get("x-nw-client-address"), null);
  }
  const other = await callFrom(stack.origin, SECOND_CLIENT, stack.viewPath);
  assert.deepEqual((JSON.parse(other.text) as ViewEnvelope).data, { counted: true, viewCount: 2 });
  assert.equal((await stack.store.getPublishedArticle({ slug: stack.slug, locale: "en" }))?.viewCount, 2);
});

test("a named ingress appends the real peer and left-hand spoofing cannot change the trusted position", async (t) => {
  const stack = await startClientAddressStack({ WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: `${EDGE_PEER}/32` });
  t.after(() => stack.close());
  const edge = await startEdge(stack.origin);
  t.after(() => edge.close());
  const first = await callFrom(edge.origin, FIRST_CLIENT, stack.viewPath, { headers: { "x-forwarded-for": "198.51.100.1" } });
  assert.equal(first.status, 200);
  assert.deepEqual((JSON.parse(first.text) as ViewEnvelope).data, { counted: true, viewCount: 1 });
  const same = await callFrom(edge.origin, FIRST_CLIENT, stack.viewPath, { headers: { "x-forwarded-for": "198.51.100.2, 198.51.100.3" } });
  assert.deepEqual((JSON.parse(same.text) as ViewEnvelope).data, { counted: false, viewCount: 1 });
  const second = await callFrom(edge.origin, SECOND_CLIENT, stack.viewPath);
  assert.deepEqual((JSON.parse(second.text) as ViewEnvelope).data, { counted: true, viewCount: 2 });
  const direct = await callFrom(stack.origin, FIRST_CLIENT, stack.viewPath, { headers: { "x-forwarded-for": "198.51.100.4" } });
  assert.deepEqual((JSON.parse(direct.text) as ViewEnvelope).data, { counted: false, viewCount: 2 });
  const changed = await callFrom(stack.origin, FIRST_CLIENT, stack.viewPath, { headers: { "x-forwarded-for": "198.51.100.5" } });
  assert.deepEqual((JSON.parse(changed.text) as ViewEnvelope).data, { counted: false, viewCount: 2 });
  assert.equal((await stack.store.getPublishedArticle({ slug: stack.slug, locale: "en" }))?.viewCount, 2);
});

test("one client's sixty failed logins do not lock a different IP out of its valid account", async (t) => {
  const stack = await startClientAddressStack();
  t.after(() => stack.close());
  const suffix = randomUUID();
  const account = await registerClient(stack.origin, SECOND_CLIENT, `normal-${suffix}@example.test`);
  for (let attempt = 0; attempt < 60; attempt++) {
    const failed = await callFrom(stack.origin, FIRST_CLIENT, "/api/auth/login", {
      body: { email: `missing-${attempt}-${suffix}@example.test`, password: BRIDGE_PASSWORD },
      headers: { "x-forwarded-for": `198.51.100.${attempt + 1}` },
    });
    assert.equal(failed.status, 401, `attempt ${attempt + 1} retains the real 60/IP policy`);
    assert.equal(failed.headers.getSetCookie().length, 0);
  }
  const throttled = await callFrom(stack.origin, FIRST_CLIENT, "/api/auth/login", { body: { email: account.email, password: BRIDGE_PASSWORD } });
  assert.equal(throttled.status, 429);
  assert.match(throttled.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
  const independent = await callFrom(stack.origin, SECOND_CLIENT, "/api/auth/login", { body: { email: account.email, password: BRIDGE_PASSWORD } });
  assert.equal(independent.status, 200);
  assert.ok(independent.headers.getSetCookie().some((cookie) => cookie.startsWith("nw_access=")));
  assert.equal(independent.text.includes("accessToken"), false);
  assert.equal(independent.text.includes("refreshToken"), false);
  const stillThrottled = await callFrom(stack.origin, FIRST_CLIENT, "/api/auth/login", {
    body: { email: `fresh-${suffix}@example.test`, password: BRIDGE_PASSWORD },
    headers: { "x-nw-client-address": SECOND_CLIENT, "x-forwarded-for": SECOND_CLIENT },
  });
  assert.equal(stillThrottled.status, 429);
});

test("the thirty-per-IP article-create budget is independent without weakening ten-per-user limits", async (t) => {
  const stack = await startClientAddressStack();
  t.after(() => stack.close());
  const suffix = randomUUID();
  const authors = [];
  for (let index = 0; index < 4; index++) authors.push(await registerClient(stack.origin, FIRST_CLIENT, `writer-${index}-${suffix}@example.test`));
  const bodyFor = (index: number) => ({ title: `Address isolation ${index}`, slug: `address-${index}-${suffix}`, locale: "en",
    contentBlocks: [{ id: "p1", type: "paragraph", text: `Persisted work ${index}.` }], publish: false });
  for (let index = 0; index < 30; index++) {
    const result = await callFrom(stack.origin, FIRST_CLIENT, "/api/authoring/articles", {
      body: bodyFor(index), headers: { cookie: authors[Math.floor(index / 10)]!.cookie, "idempotency-key": `bridge-${suffix}-${index}` },
    });
    assert.equal(result.status, 201, `create ${index + 1} keeps the production allowance`);
  }
  const sameIp = await callFrom(stack.origin, FIRST_CLIENT, "/api/authoring/articles", { body: bodyFor(30), headers: { cookie: authors[3]!.cookie } });
  assert.equal(sameIp.status, 429);
  assert.match(sameIp.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
  const differentIp = await callFrom(stack.origin, SECOND_CLIENT, "/api/authoring/articles", { body: bodyFor(31), headers: { cookie: authors[3]!.cookie } });
  assert.equal(differentIp.status, 201);
  const userLimited = await callFrom(stack.origin, SECOND_CLIENT, "/api/authoring/articles", { body: bodyFor(32), headers: { cookie: authors[0]!.cookie } });
  assert.equal(userLimited.status, 429, "moving to another IP never resets the account's own quota");
  const drafts = await stack.store.listMyArticles({ actorId: JSON.parse(differentIp.text).data.authorId, locale: "en", limit: 100 });
  assert.equal(drafts.length, 1, "rejected creates did not persist articles");
});

test("overlapping readers retain separate request contexts while their upstream work awaits", async (t) => {
  const stack = await startClientAddressStack();
  t.after(() => stack.close());
  const peers = Array.from({ length: 8 }, (_, index) => `127.0.1.${index + 1}`);
  const results = await Promise.all(peers.map((peer) => callFrom(stack.origin, peer, stack.viewPath)));
  assert.ok(results.every((result) => result.status === 200));
  assert.ok(results.every((result) => (JSON.parse(result.text) as ViewEnvelope).data.counted));
  assert.deepEqual(results.map((result) => (JSON.parse(result.text) as ViewEnvelope).data.viewCount).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  const repeats = await Promise.all(peers.map((peer) => callFrom(stack.origin, peer, stack.viewPath, { headers: { "x-forwarded-for": "203.0.113.88" } })));
  assert.ok(repeats.every((result) => !(JSON.parse(result.text) as ViewEnvelope).data.counted));
  assert.equal((await stack.store.getPublishedArticle({ slug: stack.slug, locale: "en" }))?.viewCount, 8);
  for (const result of [...results, ...repeats]) {
    assert.match(result.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(result.text.includes(BRIDGE_SECRET), false);
  }
});

test("direct API callers without a valid BFF proof cannot choose a fresh address", async (t) => {
  const stack = await startClientAddressStack();
  t.after(() => stack.close());
  const path = `/api/v1/articles/${stack.slug}/views?locale=en`;
  const first = await callFrom(stack.apiOrigin, FIRST_CLIENT, path);
  assert.deepEqual((JSON.parse(first.text) as ViewEnvelope).data, { counted: true, viewCount: 1 });
  for (const candidate of ["198.51.100.1", "2001:db8::44", SECOND_CLIENT]) {
    const forged = await callFrom(stack.apiOrigin, FIRST_CLIENT, path, { headers: {
      "x-forwarded-for": candidate, "x-nw-client-address": candidate, "x-nw-client-address-proof": "v1.1.invalid",
    } });
    assert.equal(forged.status, 200);
    assert.deepEqual((JSON.parse(forged.text) as ViewEnvelope).data, { counted: false, viewCount: 1 });
  }
  const second = await callFrom(stack.apiOrigin, SECOND_CLIENT, path);
  assert.deepEqual((JSON.parse(second.text) as ViewEnvelope).data, { counted: true, viewCount: 2 });
  assert.equal((await stack.store.getPublishedArticle({ slug: stack.slug, locale: "en" }))?.viewCount, 2);
});
