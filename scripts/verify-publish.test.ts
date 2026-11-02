import assert from "node:assert/strict";
import test from "node:test";

import {
  formatReport,
  mailVariablesIn,
  parseArguments,
  verifyPublish,
  type FetchImpl,
} from "./verify-publish.ts";

/**
 * The publish verifier is a local diagnostic, not production code: these tests
 * pin its observable HTTP contract with a fake fetch, so a regression in the
 * profile prerequisite, the mail-free path or the Web SSR assertions is caught
 * without starting real processes.
 */

const API = "http://api.test";
const WEB = "http://web.test";
const IDENTITY = {
  email: "verify-publish@example.test",
  password: "verify-publish-password",
  slug: "verify-slug",
  title: "验证标题",
};
const BODY_TEXT = "无邮箱服务发布验证正文";

type Call = { url: string; method: string };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const responseHeaders = new Headers({ "content-type": "application/json", ...headers });
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function loginResponse(): Response {
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", "nw_access=access-cookie; Path=/api/authoring");
  headers.append("set-cookie", "nw_refresh=refresh-cookie; Path=/api/auth");
  return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers });
}

type Router = (url: string, init?: RequestInit) => Promise<Response>;

function fakeFetch(router: Router): { fetchImpl: FetchImpl; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: String(init?.method ?? "GET") });
    return router(url, init);
  };
  return { fetchImpl, calls };
}

function successfulRouter(): Router {
  return async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/api/v1/auth/register") return jsonResponse({ data: { accessToken: "test-access-token" } }, 201);
    if (path === "/api/v1/me/profile") return jsonResponse({ data: { displayName: "发布验证作者" } });
    if (path === "/api/auth/login") return loginResponse();
    if (path === "/api/authoring/articles") {
      return jsonResponse({ data: { slug: IDENTITY.slug, title: IDENTITY.title, status: "published" } }, 201);
    }
    if (path === "/api/authoring/session") {
      return jsonResponse({ data: { email: IDENTITY.email, emailVerifiedAt: null, isEditor: false } });
    }
    if (path === `/api/v1/articles/${IDENTITY.slug}`) {
      return jsonResponse({
        data: {
          slug: IDENTITY.slug,
          title: IDENTITY.title,
          author: { displayName: "发布验证作者" },
          status: "published",
          publishedAt: "2026-11-03T00:00:00.000Z",
        },
      });
    }
    if (path === "/api/v1/articles") {
      return jsonResponse({ data: [{ slug: IDENTITY.slug, title: IDENTITY.title }] });
    }
    if (path === `/articles/${IDENTITY.slug}`) return htmlResponse(`<h1>${IDENTITY.title}</h1><p>${BODY_TEXT}</p>`);
    if (path === "/articles") return htmlResponse(`<h2>${IDENTITY.title}</h2>`);
    return jsonResponse({ error: { code: "NOT_FOUND" } }, 404);
  };
}

test("argument parsing accepts the supported combinations and rejects ambiguous ones", () => {
  assert.deepEqual(parseArguments([]).args, { keep: false, json: false });
  assert.deepEqual(parseArguments(["--keep", "--json"]).args, { keep: true, json: true });
  assert.deepEqual(parseArguments(["--api-url", "http://127.0.0.1:4000", "--web-url", "http://127.0.0.1:3000/", "--timeout", "5000"]).args, {
    keep: false,
    json: false,
    apiUrl: "http://127.0.0.1:4000",
    webUrl: "http://127.0.0.1:3000",
    timeoutMs: 5000,
  });
  assert.match(parseArguments(["--api-url", "http://127.0.0.1:4000"]).error ?? "", /must be supplied together/);
  assert.match(parseArguments(["--keep", "--api-url", API, "--web-url", WEB]).error ?? "", /only applies to the stack/);
  assert.match(parseArguments(["--timeout", "0"]).error ?? "", /positive integer/);
  assert.match(parseArguments(["--api-url", "ftp://api.test", "--web-url", WEB]).error ?? "", /absolute HTTP\(S\)/);
  assert.match(parseArguments(["--nope"]).error ?? "", /Unknown option/);
});

test("mail variables are the only environment names that switch mail on", () => {
  assert.deepEqual(mailVariablesIn({ PATH: "/bin", DATABASE_PROVIDER: "sqlite" }), []);
  assert.deepEqual(mailVariablesIn({ MAIL_ENABLED: "", MAIL_SMTP_HOST: "smtp.test" }), ["MAIL_SMTP_HOST"]);
});

test("a mail-free publish is verified through the writing-desk proxy and Web SSR", async () => {
  const { fetchImpl, calls } = fakeFetch(successfulRouter());
  const outcome = await verifyPublish({
    apiBaseUrl: API,
    webBaseUrl: WEB,
    identity: IDENTITY,
    mailEnvironment: { PATH: "/bin", DATABASE_PROVIDER: "sqlite" },
    fetchImpl,
  });

  assert.equal(outcome.failed, 0, JSON.stringify(outcome.results, null, 2));
  assert.equal(outcome.article?.webUrl, `${WEB}/articles/${IDENTITY.slug}`);
  assert.equal(outcome.article?.archiveUrl, `${WEB}/articles`);
  assert.deepEqual(
    outcome.results.map((result) => result.id),
    ["api.register", "api.profile", "web.login", "web.publish", "mail.independent", "api.article", "api.list", "web.article", "web.archive"],
  );
  for (const result of outcome.results) assert.equal(result.status, "pass", `${result.id}: ${result.detail}`);

  // The profile write is the visibility precondition, so it must happen before
  // the writing desk publishes. The mail-free claim is also a positive assertion:
  // no verification/reset endpoint is ever called.
  const profileIndex = calls.findIndex((call) => call.url.includes("/api/v1/me/profile"));
  const publishIndex = calls.findIndex((call) => call.url.includes("/api/authoring/articles"));
  assert.ok(profileIndex >= 0 && publishIndex > profileIndex);
  assert.equal(calls.some((call) => /verify-email|forgot-password|email-verification/.test(call.url)), false);
  assert.equal(calls.some((call) => call.url.includes("/api/v1/auth/login")), false, "the Web login proxy, not the API login, is the browser path");
});

test("an article with author: null fails with the profile remedy", async () => {
  const router: Router = async (url) => {
    if (new URL(url).pathname === `/api/v1/articles/${IDENTITY.slug}`) {
      return jsonResponse({ data: { slug: IDENTITY.slug, title: IDENTITY.title, author: null } });
    }
    return successfulRouter()(url);
  };
  const { fetchImpl } = fakeFetch(router);
  const outcome = await verifyPublish({
    apiBaseUrl: API,
    webBaseUrl: WEB,
    identity: IDENTITY,
    mailEnvironment: {},
    fetchImpl,
  });

  const article = outcome.results.find((result) => result.id === "api.article");
  assert.equal(article?.status, "fail");
  assert.match(article?.detail ?? "", /author/);
  assert.match(article?.remedy ?? "", /me\/profile/);
  assert.ok(outcome.failed >= 1);
});

test("a Web page without the API title fails with the API_BASE_URL / locale remedy", async () => {
  const router: Router = async (url) => {
    if (new URL(url).pathname === "/articles") return htmlResponse("<h2>静态 fixture</h2>");
    return successfulRouter()(url);
  };
  const { fetchImpl } = fakeFetch(router);
  const outcome = await verifyPublish({
    apiBaseUrl: API,
    webBaseUrl: WEB,
    identity: IDENTITY,
    mailEnvironment: {},
    fetchImpl,
  });

  const archive = outcome.results.find((result) => result.id === "web.archive");
  assert.equal(archive?.status, "fail");
  assert.match(archive?.remedy ?? "", /API_BASE_URL|locale/);
});

test("an inherited MAIL_* variable fails the mail-free assertion", async () => {
  const { fetchImpl } = fakeFetch(successfulRouter());
  const outcome = await verifyPublish({
    apiBaseUrl: API,
    webBaseUrl: WEB,
    identity: IDENTITY,
    mailEnvironment: { MAIL_ENABLED: "true", MAIL_SMTP_HOST: "smtp.test" },
    fetchImpl,
  });

  const mail = outcome.results.find((result) => result.id === "mail.independent");
  assert.equal(mail?.status, "fail");
  assert.match(mail?.detail ?? "", /MAIL_ENABLED/);
});

test("the report prints the article links and the mail-free summary", async () => {
  const { fetchImpl } = fakeFetch(successfulRouter());
  const outcome = await verifyPublish({
    apiBaseUrl: API,
    webBaseUrl: WEB,
    identity: IDENTITY,
    mailEnvironment: {},
    fetchImpl,
  });
  const report = formatReport(outcome, { apiBaseUrl: API, webBaseUrl: WEB, startedStack: true });
  assert.match(report, /mail  关闭/);
  assert.match(report, /文章页    http:\/\/web\.test\/articles\/verify-slug/);
  assert.match(report, /作品目录  http:\/\/web\.test\/articles/);
  assert.match(report, /发布链路已验证/);
});
