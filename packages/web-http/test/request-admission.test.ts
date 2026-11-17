import assert from "node:assert/strict";
import test from "node:test";
import { WebRequestAdmission } from "../src/request-admission.ts";

const incoming = (overrides: Record<string, string | null> = {}) => ({ method: "POST", path: "/api/authoring/media", contentLength: "100", transferEncoding: null, ...overrides });

test("request/body reservations last until response completion, not merely until bytes arrive", () => {
  const budget = new WebRequestAdmission({ concurrency: 2, bodyBudgetBytes: 150, maxBodyBytes: 100 });
  const first = budget.acquire(incoming()); assert.equal(first.ok, true);
  const blocked = budget.acquire(incoming()); assert.equal(blocked.ok, false);
  if (!blocked.ok) { assert.equal(blocked.status, 503); assert.equal(blocked.reason, "body-capacity"); }
  assert.equal(budget.snapshot().ordinary.reservedBytes, 100);
  if (first.ok) { first.release("completed"); first.release("aborted"); }
  const next = budget.acquire(incoming()); assert.equal(next.ok, true);
  if (next.ok) next.release("completed");
  assert.equal(budget.snapshot().completed, 2);
  assert.equal(budget.snapshot().aborted, 0);
});

test("chunked uploads reserve the full permitted body and advertised oversize is refused before intake", () => {
  const budget = new WebRequestAdmission({ concurrency: 5, bodyBudgetBytes: 200, maxBodyBytes: 100 });
  const first = budget.acquire(incoming({ contentLength: null, transferEncoding: "chunked" }));
  const second = budget.acquire(incoming({ contentLength: null, transferEncoding: "chunked" }));
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  const third = budget.acquire(incoming({ contentLength: null, transferEncoding: "chunked" })); assert.equal(third.ok, false);
  const oversized = budget.acquire(incoming({ contentLength: "101" }));
  assert.equal(oversized.ok, false); if (!oversized.ok) assert.equal(oversized.status, 413);
  if (first.ok) first.release("completed"); if (second.ok) second.release("completed");
});

test("ordinary saturation cannot consume reserved session requests or their small body budget", () => {
  const budget = new WebRequestAdmission({ concurrency: 1, bodyBudgetBytes: 100, maxBodyBytes: 100 });
  const upload = budget.acquire(incoming()); assert.equal(upload.ok, true);
  const signIn = budget.acquire(incoming({ path: "/api/auth/login", contentLength: null, transferEncoding: "chunked" }));
  assert.equal(signIn.ok, true);
  const ordinary = budget.acquire(incoming({ method: "GET", path: "/articles", contentLength: null })); assert.equal(ordinary.ok, false);
  assert.equal(budget.snapshot().session.reservedBytes, 4096);
  if (signIn.ok) signIn.release("failed"); if (upload.ok) upload.release("aborted");
  assert.equal(budget.snapshot().failed, 1); assert.equal(budget.snapshot().aborted, 1);
});

test("framing ambiguities and read-method bodies are rejected without acquiring resources", () => {
  const budget = new WebRequestAdmission();
  for (const descriptor of [incoming({ contentLength: "-1" }), incoming({ contentLength: "1,1" }), incoming({ contentLength: "1e2" }),
    incoming({ transferEncoding: "chunked" }), incoming({ contentLength: null, transferEncoding: "gzip" }), incoming({ method: "GET" }),
    incoming({ method: "HEAD", contentLength: null, transferEncoding: "chunked" })]) {
    const result = budget.acquire(descriptor); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  }
  assert.equal(budget.snapshot().ordinary.active, 0);
  const head = budget.acquire(incoming({ method: "HEAD", contentLength: "0", transferEncoding: null })); assert.equal(head.ok, true);
  if (head.ok) head.release("completed");
});

test("session-like query strings, prefixes and unrelated paths cannot borrow reserved capacity", () => {
  const budget = new WebRequestAdmission({ concurrency: 1 });
  const busy = budget.acquire(incoming({ method: "GET", contentLength: null }));
  for (const path of ["/api/auth/login/extra", "/anything?next=/api/auth/login", "/api/authentication/login", "/api/authoring/sessions"]) {
    assert.equal(budget.acquire(incoming({ method: "GET", path, contentLength: null })).ok, false, path);
  }
  const session = budget.acquire(incoming({ method: "GET", path: "/api/authoring/session?refresh=1", contentLength: null }));
  assert.equal(session.ok, true);
  if (session.ok) session.release("completed"); if (busy.ok) busy.release("completed");
});

test("draining refuses new admissions but preserves accurate outstanding ownership", () => {
  const budget = new WebRequestAdmission();
  const active = budget.acquire(incoming());
  budget.stop(); budget.stop();
  const refusal = budget.acquire(incoming()); assert.equal(refusal.ok, false);
  if (!refusal.ok) assert.equal(refusal.reason, "closing");
  assert.equal(budget.snapshot().ordinary.active, 1);
  if (active.ok) active.release("completed");
  assert.equal(budget.snapshot().ordinary.active, 0);
});

test("settings reject impossible memory/concurrency configurations without retaining input", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 1_000_000]) {
    assert.throws(() => new WebRequestAdmission({ concurrency: value }), RangeError);
    assert.throws(() => new WebRequestAdmission({ bodyBudgetBytes: value, maxBodyBytes: 8_000_000 }), RangeError);
  }
});
