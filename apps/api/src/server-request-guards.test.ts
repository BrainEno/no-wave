/** Write rate limits, trusted-proxy addresses, error logging, input validation and locales. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createApiServer } from "./server.ts";
import { authEnv, signedToken, withServer } from "./test-support/rest-server-harness.ts";

test("REST write rate limits return 429 and Retry-After before invoking a mutation", async () => {
  const calls = [];
  let writes = 0;
  const applicationServices = {
    async isSessionRevoked() { return false; },
    async consumeRateLimit(input) {
      calls.push(input);
      return {
        allowed: calls.length === 1,
        resetAt: new Date(Date.now() + 3200).toISOString(),
      };
    },
    async createArticle() { writes += 1; return {}; },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/articles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("rate-limited-writer"),
        "x-forwarded-for": "203.0.113.99",
      },
      body: JSON.stringify({
        slug: "rate-limited",
        title: "Rate limited",
        contentBlocks: [{ id: "p1", type: "paragraph", text: "Test" }],
      }),
    });
    assert.equal(response.status, 429);
    assert.match(response.headers.get("retry-after") ?? "", /^[1-4]$/);
    assert.deepEqual(await response.json(), {
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.limit), [10, 30]);
    assert.ok(calls.every((call) => /^[a-f0-9]{64}$/.test(call.key)));
    assert.ok(calls.every((call) => !call.key.includes("203.0.113.99") && !call.key.includes("rate-limited-writer")));
    assert.equal(writes, 0);
  }, { env: authEnv, applicationServices });
});

/**
 * The limiter resolves a policy from the *matched route id*, not from the path.
 *
 * Article creation was already covered above, so this uses routes that used to
 * inherit the generic limits by falling through a default — a write whose limit
 * nobody had written down. The assertion is the pair of bucket limits: they are
 * the taxonomy rows from ADR 0011, reached through the route table rather than
 * through a second list of path regexes.
 */
test("REST write rate limits resolve through the route id, including routes with no bespoke limits", async () => {
  const calls = [];
  const applicationServices = {
    async isSessionRevoked() { return false; },
    async consumeRateLimit(input) {
      calls.push(input);
      // The user bucket passes and the shared IP bucket is exhausted, so both
      // rows of the policy are visible in one request.
      return { allowed: calls.length === 1, resetAt: new Date(Date.now() + 3200).toISOString() };
    },
    async createTaxonomy() { throw new Error("The rate-limit check must run before persistence."); },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/tags", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("taxonomy-writer"),
      },
      body: JSON.stringify({ slug: "rate-limited-tag", name: "Rate limited" }),
    });
    assert.equal(response.status, 429);
    assert.match(response.headers.get("retry-after") ?? "", /^[1-4]$/);
    // User bucket first, then the shared IP bucket: 30 and 60 a minute.
    assert.deepEqual(calls.map((call) => call.limit), [30, 60]);
    assert.deepEqual(calls.map((call) => call.windowSeconds), [60, 60]);
  }, { env: authEnv, applicationServices });
});

test("REST write rate limiter ignores spoofed forwarding headers and uses the verified user", async () => {
  const calls = [];
  const applicationServices = {
    async isSessionRevoked() { return false; },
    async consumeRateLimit(input) {
      calls.push(input);
      return { allowed: true, resetAt: new Date(Date.now() + 60000).toISOString() };
    },
    async createArticle() { throw new Error("The rate-limit smoke test must not reach persistence."); },
  };
  await withServer(async (baseUrl) => {
    for (const forwardedFor of ["198.51.100.1", "198.51.100.2"]) {
      const response = await fetch(baseUrl + "/api/v1/articles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + signedToken("same-writer"),
          "x-forwarded-for": forwardedFor,
        },
        body: "not json",
      });
      // The request passed throttling and then reached normal JSON validation.
      assert.equal(response.status, 400);
    }
    assert.equal(calls.length, 4);
    assert.equal(calls[0].key, calls[2].key, "verified user bucket must be stable");
    assert.equal(calls[1].key, calls[3].key, "IP bucket must use the socket peer, not X-Forwarded-For");
  }, { env: authEnv, applicationServices });
});

test("an unhandled failure is logged without the connection string it was handed", async () => {
  // Audit F-21: the 500 log line exists because "the access log says 500 and
  // nothing else" is not diagnosable, but a driver message can quote back the DSN
  // it was given. The line keeps the class and the useful part of the message and
  // loses the credentials.
  const store = {
    async listPublishedArticles() {
      throw new Error("connection failed for postgres://writer:hunter2@db.internal:5432/no_wave");
    },
  };
  // The failure line is written by `writeStructuredLog` (one JSON object to
  // stderr), not by the request logger, so the test captures the stream itself.
  const written = [];
  const write = mock.method(process.stderr, "write", (chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(baseUrl + "/api/v1/articles?locale=zh-CN");
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error.code, "INTERNAL_SERVER_ERROR");
    }, { env: { ...authEnv, DATABASE_URL: "postgres://writer:hunter2@db.internal:5432/no_wave" }, store });
  } finally {
    write.mock.restore();
  }

  const lines = written.join("").split("\n").filter(Boolean);
  const line = lines.find((candidate) => candidate.includes("rest_unhandled_error"));
  assert.ok(line, "the failure must be visible to the operator");
  const failure = JSON.parse(line);
  assert.equal(failure.level, "error");
  assert.equal(failure.errorName, "Error");
  assert.equal(line.includes("hunter2"), false, "the password never reaches the log");
  assert.match(failure.errorMessage, /db\.internal:5432\/no_wave/, "the host and database are still useful");
});

test("a configured trusted proxy makes the forwarded address the bucket, and only that far from the right", async () => {
  // Audit F-21: behind a reverse proxy the socket peer is the proxy, so every
  // visitor shared one IP bucket. `TRUSTED_PROXY_HOPS` names how many proxies are
  // in front of the API; the address is read that many entries from the right, so
  // a client can prepend whatever it likes without moving the position.
  const calls = [];
  const applicationServices = {
    async isSessionRevoked() { return false; },
    async consumeRateLimit(input) {
      calls.push(input);
      return { allowed: true, resetAt: new Date(Date.now() + 60000).toISOString() };
    },
    async createArticle() { throw new Error("The rate-limit smoke test must not reach persistence."); },
  };
  await withServer(async (baseUrl) => {
    const attempt = async (forwardedFor: string) => {
      const response = await fetch(baseUrl + "/api/v1/articles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + signedToken("proxy-writer"),
          "x-forwarded-for": forwardedFor,
        },
        body: "not json",
      });
      assert.equal(response.status, 400);
    };
    // Two different visitors behind the same proxy: different IP buckets.
    await attempt("203.0.113.10");
    await attempt("203.0.113.11");
    // A spoofed prefix does not move the client, because the proxy appended the
    // real address last.
    await attempt("198.51.100.99, 203.0.113.10");
  }, { env: { ...authEnv, TRUSTED_PROXY_HOPS: "1" }, applicationServices });

  assert.equal(calls.length, 6);
  assert.notEqual(calls[1].key, calls[3].key, "two visitors behind one proxy are two buckets");
  assert.equal(calls[5].key, calls[1].key, "a spoofed prefix does not move the client");
});

test("an unusable TRUSTED_PROXY_HOPS refuses to start the server instead of quietly sharing one bucket", async () => {
  assert.throws(
    () => createApiServer({ env: { ...authEnv, TRUSTED_PROXY_HOPS: "true" }, store: null }),
    (error: unknown) => error instanceof RangeError && /TRUSTED_PROXY_HOPS/.test((error as Error).message),
  );
});

test("REST rejects unsupported locales, oversized search terms and offsets before persistence", async () => {
  let calls = 0;
  const oversizedQuery = "x".repeat(201);
  await withServer(async (baseUrl) => {
    for (const path of [
      "/api/v1/articles?locale=fr",
      `/api/v1/articles?query=${oversizedQuery}`,
      "/api/v1/articles?offset=100001",
      "/api/v1/categories?locale=fr",
      `/api/v1/categories?query=${oversizedQuery}`,
      "/api/v1/categories?offset=1000001",
      "/api/v1/tags?locale=fr",
      `/api/v1/tags?query=${oversizedQuery}`,
      "/api/v1/tags?offset=1000001",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 400, path);
      assert.equal((await response.json()).error.code, "BAD_USER_INPUT");
    }
    const malformedSlug = await fetch(`${baseUrl}/api/v1/categories/%E0%A4%A`);
    assert.equal(malformedSlug.status, 400);
    assert.equal((await malformedSlug.json()).error.code, "BAD_USER_INPUT");
    const malformedTagSlug = await fetch(`${baseUrl}/api/v1/tags/%E0%A4%A`);
    assert.equal(malformedTagSlug.status, 400);
    assert.equal((await malformedTagSlug.json()).error.code, "BAD_USER_INPUT");
    const malformedTagArticlesSlug = await fetch(`${baseUrl}/api/v1/tags/%E0%A4%A/articles`);
    assert.equal(malformedTagArticlesSlug.status, 400);
    assert.equal((await malformedTagArticlesSlug.json()).error.code, "BAD_USER_INPUT");
    assert.equal(calls, 0);
  }, {
    store: {
      async listPublishedArticles() { calls += 1; return []; },
      async listTaxonomies() { calls += 1; return []; },
      async getTaxonomyBySlug() { calls += 1; return null; },
    },
  });
});

test("REST public content routes accept zh-CN, zh-TW and en without locale fallback", async () => {
  const calls: Array<[string, string]> = [];
  await withServer(async (baseUrl) => {
    for (const locale of ["zh-CN", "zh-TW", "en"]) {
      for (const path of [
        `/api/v1/articles?locale=${locale}`,
        `/api/v1/categories?locale=${locale}`,
        `/api/v1/tags?locale=${locale}`,
      ]) {
        const response = await fetch(baseUrl + path);
        assert.equal(response.status, 200, path);
        assert.deepEqual((await response.json()).data, [], path);
      }
    }
    assert.deepEqual(calls, [
      ["article", "zh-CN"], ["category", "zh-CN"], ["tag", "zh-CN"],
      ["article", "zh-TW"], ["category", "zh-TW"], ["tag", "zh-TW"],
      ["article", "en"], ["category", "en"], ["tag", "en"],
    ]);
  }, {
    store: {
      async listPublishedArticles(args) { calls.push(["article", args.locale]); return []; },
      async listTaxonomies(args) { calls.push([args.kind, args.locale]); return []; },
    },
  });
});
