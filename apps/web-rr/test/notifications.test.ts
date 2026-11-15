import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MOCK_NOTIFICATION, MOCK_TOKENS, startMockRestApi } from "../mocks/rest-api.ts";
import { startProductionWeb } from "./support/production-web.ts";

let api: Awaited<ReturnType<typeof startMockRestApi>>;
let app: Awaited<ReturnType<typeof startProductionWeb>>;
before(async () => {
  api = await startMockRestApi();
  app = await startProductionWeb({ API_BASE_URL: api.url, SITE_URL: "https://notifications.example.test" });
});
after(async () => { await app?.close(); await api?.close(); });

async function get(path: string, cookie = "", method = "GET") {
  const response = await fetch(`${app.origin}${path}`, { method, redirect: "manual", headers: { cookie } });
  return { status: response.status, headers: response.headers, body: await response.text() };
}
const marker = () => `nw_session=${Math.floor(Date.now() / 1000) + 3600}`;

for (const prefix of ["", "/en"]) {
  test(`${prefix || "Chinese"} notification entry redirects privately and preserves only safe filters`, async () => {
    api.resetRequests();
    const response = await get(`${prefix}/notifications?view=unread&kind=messages&actorId=private&next=https://outside.invalid`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    const redirect = new URL(response.headers.get("location")!, app.origin);
    assert.equal(redirect.pathname, "/sign-in");
    assert.equal(redirect.searchParams.get("next"), `${prefix}/notifications?view=unread&kind=messages`);
    assert.deepEqual(api.requests(), [], "a page marker check must never refresh a credential or read private data");
  });

  test(`${prefix || "Chinese"} live marker opens only a localized, noindex, no-store notification shell`, async () => {
    api.resetRequests();
    const response = await get(`${prefix}/notifications`, marker());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(response.body, /data-route="notifications"/);
    assert.match(response.body, /name="robots" content="noindex, nofollow"/);
    assert.ok(response.body.includes(`<html lang="${prefix ? "en" : "zh-CN"}">`));
    assert.match(response.body, prefix ? /Notifications \| No Wave/ : /通知 \| 无浪潮/);
    assert.ok(!response.body.includes(MOCK_NOTIFICATION.id));
    assert.ok(!response.body.includes("nw-authoring-inbox-row"));
    assert.ok(!response.body.includes(MOCK_TOKENS.accessToken));
    assert.deepEqual(api.requests(), []);
  });
}

test("English data navigation reads the framework-normalized locale, without fetching notifications in a loader", async () => {
  api.resetRequests();
  const response = await get("/en/notifications.data?view=read&kind=comments", marker());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.body, /locale/);
  assert.match(response.body, /"en"/);
  assert.ok(!response.body.includes("zh-CN"));
  assert.ok(!response.body.includes(MOCK_NOTIFICATION.id));
  assert.deepEqual(api.requests(), []);
});

test("missing, expired and malformed marker hints redirect without authorizing a notification read", async () => {
  for (const cookie of ["", "nw_session=1", "nw_session=invalid", "nw_session=999999999999999999999999999"]) {
    const response = await get("/en/notifications?view=read&view=unread&kind=unknown", cookie);
    assert.equal(response.status, 302, cookie.startsWith("nw_session=invalid") ? "malformed marker" : "unusable marker");
    const location = new URL(response.headers.get("location")!, app.origin);
    assert.equal(location.searchParams.get("next"), "/en/notifications");
  }
});

test("even a duplicate live hint grants only an empty shell, never API authorization", async () => {
  api.resetRequests();
  const response = await get("/en/notifications", `${marker()}; nw_session=1`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.ok(!response.body.includes(MOCK_NOTIFICATION.id));
  assert.deepEqual(api.requests(), []);
});

test("HEAD remains private and returns no private HTML or cookies", async () => {
  const response = await get("/en/notifications", marker(), "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.body, "");
});


test("sign-in return paths retain a valid selected notice, never an arbitrary URL or duplicate selector", async () => {
  const id = "70000000-0000-4000-8000-000000000001";
  const selected = await get(`/en/notifications?view=unread&notice=${id}&access_token=private`);
  assert.equal(new URL(selected.headers.get("location")!, app.origin).searchParams.get("next"), `/en/notifications?view=unread&notice=${id}`);
  for (const query of [`notice=${id}&notice=${id}`, "notice=https%3A%2F%2Foutside.invalid", "notice=%2Fwrite"]) {
    const invalid = await get(`/en/notifications?${query}`);
    assert.equal(new URL(invalid.headers.get("location")!, app.origin).searchParams.get("next"), "/en/notifications");
  }
});
