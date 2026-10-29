/**
 * `pnpm check:local` — end-to-end connectivity probe for the local chain.
 *
 * Layers checked, in the order a developer debugs them:
 *   1. API process                       GET  /health
 *   2. API -> database adapter           GET  /ready
 *   3. versioned REST read path          GET  /api/v1/articles
 *   4. identity + JWT configuration      POST /api/v1/auth/register       (write mode)
 *   5. authenticated write path          PUT  /api/v1/me/profile          (write mode)
 *   6. publish path                      POST /api/v1/articles            (write mode)
 *   7. anonymous read of written data    GET  /api/v1/articles/:slug
 *   8. Web server -> API (SSR)           GET  :3000/articles/:slug
 *   9. Web same-origin API proxy         GET  :3000/api/articles/:slug/comments
 *  10. Web auth proxy + cookie boundary  POST :3000/api/auth/login         (write mode)
 *
 * The probe intentionally uses the public HTTP contract only. It never imports
 * `apps/*` code, so the same script verifies a SQLite file, a Docker PostgreSQL
 * instance, or a remote staging API, and it cannot drift from a private
 * implementation detail it does not own.
 *
 * Writes go to the database the running API is configured with. Point it at a
 * disposable local database, and use `--read-only` when that is not acceptable.
 */
import {
  buildProbeIdentity,
  loadLocalEnvFile,
  originOf,
  parseCheckArguments,
  resolveLocalDevConfig,
} from "./lib/local-dev-config.ts";

export type CheckStatus = "pass" | "fail" | "skip";

export type CheckResult = {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  remedy?: string;
  durationMs: number;
};

export type CheckOptions = {
  apiBaseUrl: string;
  webBaseUrl: string;
  apiOnly: boolean;
  readOnly: boolean;
  timeoutMs: number;
};

type StepOutcome = { status?: CheckStatus; detail: string; remedy?: string };

const DEFAULT_STEP_TIMEOUT_MS = 15_000;
/** A cold `next dev` compiles routes on first request; allow for that once. */
const WEB_ROUTE_TIMEOUT_MS = 120_000;

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function errorCodeOf(payload: Record<string, unknown> | null): string | null {
  const error = payload?.error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function dataOf<T extends Record<string, unknown>>(payload: Record<string, unknown> | null): T | null {
  const data = payload?.data;
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as T) : null;
}

/** Turn a failed HTTP response into an actionable remedy. */
function remedyForStatus(status: number, code: string | null): string | undefined {
  if (status === 429 || code === "RATE_LIMITED") {
    return "The API rate limit for this probe was reached. Wait for the window to reset, or rerun with --read-only.";
  }
  if (status === 503) {
    return "The API reports unavailable persistence or identity. Check AUTH_JWT_SECRET (>=32 bytes), the database process and `pnpm db:migrate`.";
  }
  if (status === 404) {
    return "The route or resource does not exist. Confirm the API and Web processes run this checkout.";
  }
  if (status === 502) {
    return "The Web server could not reach API_BASE_URL. Confirm the API port and that the URL is reachable from the Web process.";
  }
  return undefined;
}

async function runStep(
  id: string,
  title: string,
  run: () => Promise<StepOutcome>,
): Promise<CheckResult> {
  const startedAt = performance.now();
  try {
    const outcome = await run();
    return {
      id,
      title,
      status: outcome.status ?? "pass",
      detail: outcome.detail,
      ...(outcome.remedy === undefined ? {} : { remedy: outcome.remedy }),
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      id,
      title,
      status: "fail",
      detail: message,
      remedy: "The request did not complete. Confirm the process is running and the URL is reachable from this machine.",
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
}

function skipped(id: string, title: string, reason: string): CheckResult {
  return { id, title, status: "skip", detail: reason, durationMs: 0 };
}

export async function runLocalChecks(options: CheckOptions): Promise<{ results: CheckResult[]; failed: number }> {
  const api = trimBaseUrl(options.apiBaseUrl);
  const web = trimBaseUrl(options.webBaseUrl);
  const timeout = options.timeoutMs;
  const identity = buildProbeIdentity();
  const results: CheckResult[] = [];

  let accessToken: string | undefined;
  let articleSlug: string | undefined;
  let articleTitle: string | undefined;

  results.push(await runStep("api-health", "API liveness (/health)", async () => {
    const response = await request(`${api}/health`, { headers: { accept: "application/json" } }, timeout);
    const payload = await readJson(response);
    if (!response.ok) {
      return { status: "fail", detail: `GET /health -> ${response.status}`, remedy: "The API process is not responding. Run `pnpm dev` (or `pnpm dev:api`)." };
    }
    return { detail: `200 OK, service=${String(payload?.service ?? "unknown")}` };
  }));

  results.push(await runStep("api-ready", "API -> database (/ready)", async () => {
    const response = await request(`${api}/ready`, { headers: { accept: "application/json" } }, timeout);
    const payload = await readJson(response);
    if (!response.ok) {
      return {
        status: "fail",
        detail: `GET /ready -> ${response.status} ${String(payload?.persistence ?? "")}`.trim(),
        remedy: "The API cannot query its database. Start it (`pnpm db:up`), verify DATABASE_URL/DATABASE_PATH and run `pnpm db:migrate`.",
      };
    }
    return { detail: `200 OK, persistence=${String(payload?.persistence ?? "unknown")}` };
  }));

  results.push(await runStep("rest-list", "REST article list", async () => {
    const response = await request(`${api}/api/v1/articles?locale=zh-CN&limit=5`, { headers: { accept: "application/json" } }, timeout);
    const payload = await readJson(response);
    if (!response.ok) {
      return { status: "fail", detail: `GET /api/v1/articles -> ${response.status}`, remedy: remedyForStatus(response.status, errorCodeOf(payload)) };
    }
    const data = payload?.data;
    if (!Array.isArray(data)) {
      return { status: "fail", detail: "The response did not contain a data array.", remedy: "The REST contract changed; update the probe." };
    }
    if (options.readOnly && data.length > 0) {
      const first = data[0] as Record<string, unknown>;
      if (typeof first.slug === "string") articleSlug = first.slug;
      if (typeof first.title === "string") articleTitle = first.title;
    }
    return { detail: `200 OK, ${data.length} published article(s) visible` };
  }));

  if (options.readOnly) {
    results.push(
      skipped("auth-register", "Identity write (register)", "--read-only"),
      skipped("profile-write", "Authenticated write (profile)", "--read-only"),
      skipped("article-publish", "Publish path (article)", "--read-only"),
    );
  } else {
    results.push(await runStep("auth-register", "Identity write (register)", async () => {
      const response = await request(`${api}/api/v1/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: identity.email, password: identity.password }),
      }, timeout);
      const payload = await readJson(response);
      const token = dataOf<{ accessToken?: unknown }>(payload)?.accessToken;
      if (response.status !== 201 || typeof token !== "string") {
        const code = errorCodeOf(payload);
        return {
          status: "fail",
          detail: `POST /api/v1/auth/register -> ${response.status}${code ? ` ${code}` : ""}`,
          remedy: remedyForStatus(response.status, code)
            ?? "A 503 here means the API rejected its JWT configuration; AUTH_JWT_SECRET must be at least 32 bytes.",
        };
      }
      accessToken = token;
      return { detail: `201 Created, access token issued for ${identity.email}` };
    }));

    results.push(await runStep("profile-write", "Authenticated write (profile)", async () => {
      if (!accessToken) return { status: "skip", detail: "No access token from the register step." };
      const response = await request(`${api}/api/v1/me/profile`, {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ displayName: "本地联调探针" }),
      }, timeout);
      const payload = await readJson(response);
      if (!response.ok) {
        const code = errorCodeOf(payload);
        return { status: "fail", detail: `PUT /api/v1/me/profile -> ${response.status}${code ? ` ${code}` : ""}`, remedy: remedyForStatus(response.status, code) };
      }
      return { detail: "200 OK; the JWT was accepted and the profile row was written" };
    }));

    results.push(await runStep("article-publish", "Publish path (article)", async () => {
      if (!accessToken) return { status: "skip", detail: "No access token from the register step." };
      const response = await request(`${api}/api/v1/articles`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          locale: "zh-CN",
          title: identity.title,
          slug: identity.slug,
          summary: "Local connectivity probe.",
          workType: "essay",
          publish: true,
          contentBlocksVersion: 1,
          contentBlocks: [{ id: "probe-1", type: "paragraph", text: "Created by pnpm check:local." }],
        }),
      }, timeout);
      const payload = await readJson(response);
      const data = dataOf<{ slug?: unknown }>(payload);
      if (response.status !== 201 || typeof data?.slug !== "string") {
        const code = errorCodeOf(payload);
        return { status: "fail", detail: `POST /api/v1/articles -> ${response.status}${code ? ` ${code}` : ""}`, remedy: remedyForStatus(response.status, code) };
      }
      articleSlug = data.slug;
      articleTitle = identity.title;
      return { detail: `201 Created, published slug ${data.slug}` };
    }));
  }

  results.push(await runStep("public-read", "Anonymous read of a published article", async () => {
    if (!articleSlug) {
      return { status: "skip", detail: "No published article available; run without --read-only to create one." };
    }
    const response = await request(`${api}/api/v1/articles/${encodeURIComponent(articleSlug)}?locale=zh-CN`, { headers: { accept: "application/json" } }, timeout);
    const payload = await readJson(response);
    if (!response.ok) {
      return {
        status: "fail",
        detail: `GET /api/v1/articles/${articleSlug} -> ${response.status}`,
        remedy: remedyForStatus(response.status, errorCodeOf(payload)) ?? "A published article must be readable anonymously; check the publish flag.",
      };
    }
    const data = dataOf<{ title?: unknown }>(payload);
    if (typeof data?.title === "string" && !articleTitle) articleTitle = data.title;
    return { detail: `200 OK for "${String(data?.title ?? articleSlug)}"` };
  }));

  if (options.readOnly) {
    results.push(skipped("web-auth-proxy", "Web auth proxy (login)", "--read-only"));
  } else {
    results.push(await runStep("web-auth-proxy", "Web auth proxy (login + cookie)", async () => {
      const response = await request(`${web}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", origin: originOf(web) },
        body: JSON.stringify({ email: identity.email, password: identity.password }),
      }, Math.max(timeout, DEFAULT_STEP_TIMEOUT_MS));
      const payload = await readJson(response);
      if (!response.ok) {
        const code = errorCodeOf(payload);
        return {
          status: "fail",
          detail: `POST ${web}/api/auth/login -> ${response.status}${code ? ` ${code}` : ""}`,
          remedy: remedyForStatus(response.status, code)
            ?? "The Web proxy rejected the request. Check API_BASE_URL, the exact Origin header, and that the API is reachable from the Web process.",
        };
      }
      const setCookie = response.headers.get("set-cookie") ?? "";
      if (!/refresh/i.test(setCookie)) {
        return {
          status: "fail",
          detail: "The login response did not set a refresh cookie.",
          remedy: "Check the HttpOnly cookie boundary in apps/web/src/lib/authoring-proxy.ts.",
        };
      }
      return { detail: "200 OK; tokens were stored in HttpOnly cookies by the Web proxy" };
    }));
  }

  if (options.apiOnly) {
    results.push(
      skipped("web-render", "Web server -> API (SSR)", "--api-only"),
      skipped("web-comment-proxy", "Web same-origin API proxy", "--api-only"),
    );
    return summarize(results);
  }

  // 8. The Web server must reach the API and server-render API-backed HTML.
  results.push(await runStep("web-render", "Web server -> API (SSR)", async () => {
    const home = await request(`${web}/`, { headers: { accept: "text/html" } }, WEB_ROUTE_TIMEOUT_MS).catch(() => null);
    if (!home) {
      return {
        status: "fail",
        detail: `${web}/ did not respond`,
        remedy: "Start the Web dev server (`pnpm dev:web`) and confirm the port matches WEB_PORT.",
      };
    }
    if (!articleSlug) return { status: "skip", detail: "No published article to render." };
    const response = await request(`${web}/articles/${encodeURIComponent(articleSlug)}`, { headers: { accept: "text/html" } }, WEB_ROUTE_TIMEOUT_MS);
    const html = await response.text();
    if (response.status !== 200) {
      return {
        status: "fail",
        detail: `GET ${web}/articles/${articleSlug} -> ${response.status}`,
        remedy: "A 404 usually means the Web received no API data (check API_BASE_URL) or the article is still a draft.",
      };
    }
    if (articleTitle && !html.includes(articleTitle)) {
      return {
        status: "fail",
        detail: `The page rendered but did not contain the API title "${articleTitle}".`,
        remedy: "The Web is probably serving its fixture registry. Set API_BASE_URL in the repository root .env.local and restart `pnpm dev`.",
      };
    }
    return { detail: `200 OK, server-rendered API content from ${api}` };
  }));

  // 9. Same-origin proxy: the path browsers actually use.
  results.push(await runStep("web-comment-proxy", "Web same-origin API proxy", async () => {
    if (!articleSlug) return { status: "skip", detail: "No published article to query." };
    const response = await request(
      `${web}/api/articles/${encodeURIComponent(articleSlug)}/comments?locale=zh-CN`,
      { headers: { accept: "application/json" } },
      Math.max(timeout, DEFAULT_STEP_TIMEOUT_MS),
    );
    const payload = await readJson(response);
    if (!response.ok) {
      return {
        status: "fail",
        detail: `GET ${web}/api/articles/${articleSlug}/comments -> ${response.status}`,
        remedy: remedyForStatus(response.status, errorCodeOf(payload))
          ?? "The Web proxy could not reach the API. Check API_BASE_URL and that the API process is running.",
      };
    }
    const data = payload?.data;
    if (!Array.isArray(data)) {
      return { status: "fail", detail: "The proxy did not return a data array.", remedy: "The proxy contract changed; update the probe." };
    }
    return { detail: `200 OK, ${data.length} comment(s) returned through the Web proxy` };
  }));

  return summarize(results);
}

function summarize(results: CheckResult[]): { results: CheckResult[]; failed: number } {
  return { results, failed: results.filter((result) => result.status === "fail").length };
}

export function formatReport(
  results: CheckResult[],
  context: { apiBaseUrl?: string; webBaseUrl?: string; apiOnly?: boolean } = {},
): string {
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const skipped = results.filter((result) => result.status === "skip").length;
  const lines = ["", "Local development connectivity report", "==================================="];
  if (context.apiBaseUrl) lines.push(`api  ${context.apiBaseUrl}`);
  if (context.webBaseUrl && !context.apiOnly) lines.push(`web  ${context.webBaseUrl}`);
  lines.push("");
  for (const result of results) {
    const marker = result.status === "pass" ? "[pass]" : result.status === "fail" ? "[FAIL]" : "[skip]";
    const timing = result.status === "skip" ? "" : ` (${result.durationMs} ms)`;
    lines.push(`${marker} ${result.id.padEnd(18)} ${result.title}${timing}`, `       ${result.detail}`);
    if (result.remedy) lines.push(`       -> ${result.remedy}`);
  }
  lines.push("", `${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed === 0 && passed > 0) {
    lines.push(context.apiOnly
      ? "Local chain verified: database -> API."
      : "Local chain verified: database -> API -> Web -> browser-facing proxy.");
  } else if (failed > 0) {
    lines.push("Fix the [FAIL] entries first; they are ordered from the lowest layer to the highest.");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  loadLocalEnvFile();
  const parsed = parseCheckArguments(process.argv.slice(2));
  if (!parsed.args) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const config = resolveLocalDevConfig(process.env);
  const apiBaseUrl = parsed.args.apiBaseUrl ?? config.api.baseUrl;
  const webBaseUrl = parsed.args.webBaseUrl ?? config.web.baseUrl;
  const { results, failed } = await runLocalChecks({
    apiBaseUrl,
    webBaseUrl,
    apiOnly: parsed.args.apiOnly,
    readOnly: parsed.args.readOnly,
    timeoutMs: parsed.args.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
  });
  process.stdout.write(`${formatReport(results, {
    apiBaseUrl,
    webBaseUrl: parsed.args.apiOnly ? undefined : webBaseUrl,
    apiOnly: parsed.args.apiOnly,
  })}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`Local development check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
