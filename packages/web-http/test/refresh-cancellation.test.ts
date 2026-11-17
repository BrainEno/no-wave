import assert from "node:assert/strict";
import test from "node:test";
import { handleAuthRequest } from "../src/auth.ts";
import { forwardAuthoringRequest } from "../src/forward.ts";
import { API_BASE, ROTATED, json, setCookies } from "./helpers.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("cancelling either refresh entry releases only its waiter, not the one-time rotation shared by its sibling", { timeout: 5000 }, async t => {
  for (const entry of ["explicit", "automatic"] as const) {
    const entered = latch(), finish = latch();
    t.after(() => finish.resolve());
    let rotations = 0, rotationAborted = false;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.includes("auth/refresh")) {
        rotations++;
        init?.signal?.addEventListener("abort", () => { rotationAborted = true; });
        entered.resolve(); await finish.promise; return json({ data: ROTATED });
      }
      return new Headers(init?.headers).get("authorization") === `Bearer ${ROTATED.accessToken}`
        ? json({ data: [] }) : json({ error: { code: "TOKEN_EXPIRED", message: "Expired" } }, 401);
    };
    const config = { apiBaseUrl: API_BASE, fetchImpl, upstreamTimeoutMs: 1000 };
    const controller = new AbortController();
    const request = (signal?: AbortSignal) => new Request("https://no-wave.test/api/auth/refresh", { method: "POST", signal,
      headers: { origin: "https://no-wave.test", cookie: `nw_access=expired; nw_refresh=${entry[0]!.repeat(43)}` } });
    const first = entry === "explicit" ? handleAuthRequest(request(controller.signal), "refresh", config)
      : forwardAuthoringRequest(request(controller.signal), "api/v1/me/articles", "GET", config);
    await entered.promise;
    const sibling = handleAuthRequest(request(), "refresh", config);
    controller.abort(new Error("private-waiter-canary"));
    const cancelled = await Promise.race([first, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The cancelled waiter remained pinned to rotation.")), 200).unref())]);
    assert.equal(cancelled.status, 499);
    assert.deepEqual(setCookies(cancelled), []);
    assert.doesNotMatch(await cancelled.text(), /private-waiter-canary/);
    assert.equal(rotationAborted, false);
    finish.resolve();
    const refreshed = await sibling;
    assert.equal(refreshed.status, 200); assert.equal(rotations, 1);
    assert.ok(setCookies(refreshed).some(cookie => cookie.startsWith(`nw_refresh=${ROTATED.refreshToken};`)));
  }
});

test("an injected coordinator that ignores its waiter context still has a finite public deadline", { timeout: 3000 }, async () => {
  const response = await handleAuthRequest(new Request("https://no-wave.test/api/auth/refresh", { method: "POST", headers: {
    origin: "https://no-wave.test", cookie: `nw_refresh=${"r".repeat(43)}`,
  } }), "refresh", { apiBaseUrl: API_BASE, upstreamTimeoutMs: 10, refreshCoordinator: { resolve: () => new Promise(() => {}) } });
  assert.equal(response.status, 504);
  assert.deepEqual(setCookies(response), []);
});
