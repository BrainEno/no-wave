/**
 * `pnpm verify:publish` — prove that a work published from the writing desk is
 * visible, without a mail service.
 *
 *   pnpm verify:publish
 *   pnpm verify:publish --keep                 # leave the stack up, Ctrl+C stops it
 *   pnpm --silent verify:publish --json      # machine-readable result (pnpm banner suppressed)
 *   pnpm verify:publish --api-url URL --web-url URL  # verify an existing chain
 *
 * The command starts a disposable stack on free loopback ports by default: a
 * temporary SQLite file, a random JWT secret, the production Web build, and only
 * the documented environment variables the portable stack assembles. No
 * `.env.local`, no SMTP relay, no Docker and no external database are needed.
 * `MAIL_*` is deliberately absent from the child environments, so email
 * verification is off; the probe then registers an account whose address is
 * never verified and publishes through the Web writing-desk proxy anyway.
 *
 * Two preconditions are what make a "published" work invisible in practice:
 *
 *   1. `PUT /api/v1/me/profile` was never called. The API answers with
 *      `author: null`, and `mapArticle()` in the Web client filters that article
 *      out of every public list and page.
 *   2. `API_BASE_URL` is missing from the Web process, so the Web app renders
 *      its static fixture registry instead of the API that stored the article.
 *
 * The probe therefore writes the profile first, publishes through the same
 * `/api/authoring/articles` route the desk uses, then asserts the anonymous API
 * detail/list, the server-rendered article page and the archive page. It talks
 * HTTP only: no application code is imported, so an already running chain can be
 * verified with `--api-url` / `--web-url`.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProbeIdentity, originOf } from "./lib/local-dev-config.ts";
import {
  childEnvironment,
  freePort,
  portableStackEnvironment,
  startPortableStack,
  stopPortableStack,
  type CheckResult,
  type PortableStack,
  type StackOptions,
} from "./portable-stack.ts";

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type VerifyPublishArguments = {
  keep: boolean;
  json: boolean;
  apiUrl?: string;
  webUrl?: string;
  databasePath?: string;
  timeoutMs?: number;
};

export type PublishedArticle = {
  slug: string;
  title: string;
  apiUrl: string;
  webUrl: string;
  archiveUrl: string;
};

export type VerifyPublishOptions = {
  apiBaseUrl: string;
  webBaseUrl: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  identity?: ReturnType<typeof buildProbeIdentity>;
  /** Present only for the stack this command starts; undefined for external chains. */
  mailEnvironment?: Record<string, string | undefined>;
};

export type VerifyPublishOutcome = {
  results: CheckResult[];
  failed: number;
  article?: PublishedArticle;
};

type StepOutcome = { status?: CheckResult["status"]; detail: string; remedy?: string };

const DEFAULT_TIMEOUT_MS = 20_000;
const BODY_TEXT = "无邮箱服务发布验证正文";
const PROFILE_NAME = "发布验证作者";

/** Every mail switch that would let an SMTP configuration reach a child. */
export function mailVariablesIn(environment: Record<string, string | undefined>): string[] {
  return Object.keys(environment).filter((name) => {
    if (!name.startsWith("MAIL_")) return false;
    const value = environment[name];
    return typeof value === "string" && value.length > 0;
  });
}

export function parseArguments(argv: readonly string[]): { args?: VerifyPublishArguments; error?: string } {
  const args: VerifyPublishArguments = { keep: false, json: false };
  const usage = "Usage: pnpm verify:publish [--keep] [--json] [--api-url <url> --web-url <url>] [--database-path <path>] [--timeout <ms>]";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep") args.keep = true;
    else if (argument === "--json") args.json = true;
    else if (argument === "--api-url" || argument === "--web-url" || argument === "--database-path" || argument === "--timeout") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { error: `Option "${argument}" requires a value.\n${usage}` };
      index += 1;
      if (argument === "--api-url" || argument === "--web-url") {
        try {
          const url = new URL(value);
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
          const normalized = url.origin;
          if (argument === "--api-url") args.apiUrl = normalized;
          else args.webUrl = normalized;
        } catch {
          return { error: `Option "${argument}" expects an absolute HTTP(S) URL.\n${usage}` };
        }
      } else if (argument === "--database-path") {
        args.databasePath = value;
      } else {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) return { error: `Option "--timeout" expects a positive integer number of milliseconds.\n${usage}` };
        args.timeoutMs = parsed;
      }
    } else {
      return { error: `Unknown option "${argument}".\n${usage}` };
    }
  }
  if ((args.apiUrl === undefined) !== (args.webUrl === undefined)) {
    return { error: `--api-url and --web-url must be supplied together.\n${usage}` };
  }
  if (args.keep && args.apiUrl !== undefined) return { error: `--keep only applies to the stack this command starts.\n${usage}` };
  if (args.databasePath !== undefined && args.apiUrl !== undefined) {
    return { error: `--database-path only applies to the stack this command starts.\n${usage}` };
  }
  return { args };
}

function trimBaseUrl(value: string): string {
  return originOf(value);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return parseJson(await response.text());
}

function dataOf(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const data = payload?.data;
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

function errorCodeOf(payload: Record<string, unknown> | null): string | null {
  const error = payload?.error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function cookieHeader(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const pairs = cookies.map((cookie) => cookie.split(";")[0] ?? "").filter((pair) => pair.length > 0);
  return pairs.join("; ");
}

async function runStep(id: string, title: string, run: () => Promise<StepOutcome>): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    const outcome = await run();
    return {
      id,
      title,
      status: outcome.status ?? "pass",
      detail: outcome.detail,
      ...(outcome.remedy === undefined ? {} : { remedy: outcome.remedy }),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      id,
      title,
      status: "fail",
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      remedy: "Confirm the process is running and the URL is reachable from this machine.",
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Verify the publish path over HTTP. Injectable `fetchImpl` keeps the unit test
 * at the contract boundary rather than starting real processes.
 */
export async function verifyPublish(options: VerifyPublishOptions): Promise<VerifyPublishOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const identity = options.identity ?? buildProbeIdentity();
  const api = trimBaseUrl(options.apiBaseUrl);
  const web = trimBaseUrl(options.webBaseUrl);
  const webOrigin = originOf(web);
  const results: CheckResult[] = [];

  const request = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });

  let accessToken = "";
  let cookies = "";
  let published = false;
  let article: PublishedArticle | undefined;
  let articleTitle = identity.title;

  results.push(await runStep("api.register", "注册一次性账号（无邮箱验证）", async () => {
    const response = await request(`${api}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: identity.email, password: identity.password }),
    });
    const payload = await readJson(response);
    const token = dataOf(payload)?.accessToken;
    if (response.status !== 201 || typeof token !== "string") {
      return {
        status: "fail",
        detail: `POST /api/v1/auth/register → ${response.status}${errorCodeOf(payload) ? ` ${errorCodeOf(payload)}` : ""}`,
        remedy: "检查 AUTH_JWT_SECRET（至少 32 字节）、数据库迁移与 API 就绪状态；无需 MAIL_ENABLED。",
      };
    }
    accessToken = token;
    return { detail: "201；账号已创建，未发送验证邮件" };
  }));

  results.push(await runStep("api.profile", "写入作者资料（可见性前置条件）", async () => {
    if (!accessToken) return { status: "skip", detail: "上一步没有拿到 access token。" };
    const response = await request(`${api}/api/v1/me/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ displayName: PROFILE_NAME, bio: "用于验证写作台发布可见性。", locale: "zh-CN" }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      return {
        status: "fail",
        detail: `PUT /api/v1/me/profile → ${response.status}${errorCodeOf(payload) ? ` ${errorCodeOf(payload)}` : ""}`,
        remedy: "发布前必须先创建作者资料；否则 API 返回 author: null，Web 会过滤掉文章。",
      };
    }
    return { detail: "200；作者资料已写入，公开页面不会再收到 author: null" };
  }));

  results.push(await runStep("web.login", "写作台登录代理设置 HttpOnly Cookie", async () => {
    const response = await request(`${web}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", origin: webOrigin },
      body: JSON.stringify({ email: identity.email, password: identity.password }),
    });
    const header = cookieHeader(response);
    if (response.status !== 200 || header.length === 0) {
      const payload = await readJson(response);
      return {
        status: "fail",
        detail: `POST /api/auth/login → ${response.status}${errorCodeOf(payload) ? ` ${errorCodeOf(payload)}` : ""}`,
        remedy: "检查 Web 进程的 API_BASE_URL，以及登录请求的 Origin 是否与浏览器 Host 完全一致。",
      };
    }
    cookies = header;
    return { detail: "200；浏览器侧会话 Cookie 已设置" };
  }));

  results.push(await runStep("web.publish", "通过写作台代理发布文章", async () => {
    if (!cookies) return { status: "skip", detail: "上一步没有拿到会话 Cookie。" };
    const response = await request(`${web}/api/authoring/articles`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: webOrigin,
        cookie: cookies,
      },
      body: JSON.stringify({
        locale: "zh-CN",
        title: identity.title,
        slug: identity.slug,
        summary: "无邮箱服务发布验证。",
        workType: "essay",
        contentBlocksVersion: 0,
        contentBlocks: [{ id: "verify-1", type: "paragraph", text: BODY_TEXT }],
        publish: true,
      }),
    });
    const payload = await readJson(response);
    const data = dataOf(payload);
    const slug = data?.slug;
    if (response.status !== 201 || typeof slug !== "string") {
      return {
        status: "fail",
        detail: `POST /api/authoring/articles → ${response.status}${errorCodeOf(payload) ? ` ${errorCodeOf(payload)}` : ""}`,
        remedy: "检查 /api/authoring/articles 的同源 Origin、Cookie 作用域，以及 Web → API 的 API_BASE_URL。",
      };
    }
    if (typeof data?.title === "string") articleTitle = data.title;
    published = true;
    article = {
      slug,
      title: articleTitle,
      apiUrl: `${api}/api/v1/articles/${encodeURIComponent(slug)}?locale=zh-CN`,
      webUrl: `${web}/articles/${encodeURIComponent(slug)}`,
      archiveUrl: `${web}/articles`,
    };
    return { detail: `201；写作台已发布 /articles/${slug}` };
  }));

  results.push(await runStep("mail.independent", "发布不依赖邮箱服务", async () => {
    if (options.mailEnvironment === undefined) {
      return { status: "skip", detail: "外部栈：脚本不调用邮件接口；邮箱状态由该栈自己的配置决定。" };
    }
    const leaked = mailVariablesIn(options.mailEnvironment);
    if (leaked.length > 0) {
      return {
        status: "fail",
        detail: `子进程继承了 ${leaked.join(", ")}`,
        remedy: "自启动栈不应收到任何 MAIL_* 变量；确认没有从 shell 注入 SMTP 配置。",
      };
    }
    if (!published) return { status: "skip", detail: "文章尚未发布，无法证明无邮箱发布路径。" };
    if (!cookies) return { status: "skip", detail: "没有会话 Cookie，无法读取账号状态。" };
    const response = await request(`${web}/api/authoring/session`, {
      headers: { accept: "application/json", cookie: cookies },
    });
    const payload = await readJson(response);
    const verified = dataOf(payload)?.emailVerifiedAt;
    if (response.status !== 200) {
      return {
        status: "fail",
        detail: `GET /api/authoring/session → ${response.status}`,
        remedy: "检查 Web 认证代理与 API_BASE_URL。",
      };
    }
    if (typeof verified === "string") {
      return {
        status: "fail",
        detail: "账号邮箱已被验证，不能证明无邮箱服务路径",
        remedy: "在自启动栈中 MAIL_* 必须全部缺失，邮箱验证应保持关闭。",
      };
    }
    return { detail: "emailVerifiedAt 为空且文章已发布；没有调用验证邮件或 SMTP" };
  }));

  results.push(await runStep("api.article", "匿名读取文章详情", async () => {
    if (!article) return { status: "skip", detail: "没有已发布的文章。" };
    const currentArticle = article;
    const response = await request(currentArticle.apiUrl, { headers: { accept: "application/json" } });
    const payload = await readJson(response);
    const data = dataOf(payload);
    if (response.status !== 200) {
      return {
        status: "fail",
        detail: `GET /api/v1/articles/${currentArticle.slug} → ${response.status}`,
        remedy: "确认 publish: true 已写入、文章未删除，且请求的 locale 为 zh-CN。",
      };
    }
    const author = data?.author;
    if (typeof author !== "object" || author === null || typeof (author as Record<string, unknown>).displayName !== "string") {
      return {
        status: "fail",
        detail: "文章详情的 author 为空或没有 displayName",
        remedy: "发布前先 PUT /api/v1/me/profile；Web 的 mapArticle() 会过滤 author: null 的文章。",
      };
    }
    if (typeof data?.title !== "string" || !data.title.includes(articleTitle)) {
      return {
        status: "fail",
        detail: `文章标题与发布响应不一致：${String(data?.title ?? "")}`,
        remedy: "检查写作台代理是否正确转发文章正文与标题。",
      };
    }
    return { detail: "200；author 非空，已发布内容可匿名读取" };
  }));

  results.push(await runStep("api.list", "公开文章列表包含新作品", async () => {
    if (!article) return { status: "skip", detail: "没有已发布的文章。" };
    const currentArticle = article;
    const response = await request(`${api}/api/v1/articles?locale=zh-CN&limit=20`, { headers: { accept: "application/json" } });
    const payload = await readJson(response);
    const list = payload?.data;
    if (response.status !== 200 || !Array.isArray(list)) {
      return {
        status: "fail",
        detail: `GET /api/v1/articles → ${response.status}${errorCodeOf(payload) ? ` ${errorCodeOf(payload)}` : ""}`,
        remedy: "检查公开列表路由、locale 与分页参数。",
      };
    }
    const found = list.some((item) => {
      if (typeof item !== "object" || item === null) return false;
      return (item as Record<string, unknown>).slug === currentArticle.slug;
    });
    if (!found) {
      return {
        status: "fail",
        detail: `公开列表没有 ${currentArticle.slug}`,
        remedy: "检查 publish 标志、published_at 与文章状态过滤条件。",
      };
    }
    return { detail: `公开列表包含 /articles/${currentArticle.slug}` };
  }));

  results.push(await runStep("web.article", "文章页 SSR 可见", async () => {
    if (!article) return { status: "skip", detail: "没有已发布的文章。" };
    const currentArticle = article;
    const response = await request(currentArticle.webUrl, { headers: { accept: "text/html" } });
    const html = await response.text();
    if (response.status !== 200) {
      return {
        status: "fail",
        detail: `GET /articles/${currentArticle.slug} → ${response.status}`,
        remedy: "通常是 Web 进程缺少 API_BASE_URL，回退到了静态 fixture；也可能是 author: null 被过滤。",
      };
    }
    if (!html.includes(articleTitle) || !html.includes(BODY_TEXT)) {
      return {
        status: "fail",
        detail: "文章页渲染了，但 HTML 中没有标题或正文",
        remedy: "确认 API_BASE_URL 指向刚发布的 API，且写作台使用 zh-CN；/en/articles 不会显示硬编码 zh-CN 的作品。",
      };
    }
    return { detail: "200；服务端 HTML 含标题与正文" };
  }));

  results.push(await runStep("web.archive", "作品目录 SSR 可见", async () => {
    if (!article) return { status: "skip", detail: "没有已发布的文章。" };
    const currentArticle = article;
    const response = await request(currentArticle.archiveUrl, { headers: { accept: "text/html" } });
    const html = await response.text();
    if (response.status !== 200) {
      return {
        status: "fail",
        detail: `GET /articles → ${response.status}`,
        remedy: "检查 Web → API 的 API_BASE_URL 与公开列表接口。",
      };
    }
    if (!html.includes(articleTitle)) {
      return {
        status: "fail",
        detail: "作品目录渲染了，但 HTML 中没有新文章标题",
        remedy: "检查 locale：写作台目前硬编码 zh-CN，请打开 /articles 而不是 /en/articles；并确认 API_BASE_URL。",
      };
    }
    return { detail: "200；作品目录含新文章标题" };
  }));

  return {
    results,
    failed: results.filter((result) => result.status === "fail").length,
    ...(article === undefined ? {} : { article }),
  };
}

export function formatReport(outcome: VerifyPublishOutcome, context: {
  apiBaseUrl: string;
  webBaseUrl: string;
  startedStack: boolean;
}): string {
  const passed = outcome.results.filter((result) => result.status === "pass").length;
  const failed = outcome.results.filter((result) => result.status === "fail").length;
  const skipped = outcome.results.filter((result) => result.status === "skip").length;
  const lines = [
    "",
    "No Wave 发布效果验证",
    "====================",
    `api   ${context.apiBaseUrl}`,
    `web   ${context.webBaseUrl}`,
    context.startedStack
      ? "mail  关闭：子进程不继承 MAIL_*，不需要 SMTP 或邮箱验证"
      : "mail  不参与：脚本不调用邮件接口（外部栈的邮箱配置由其自身决定）",
    "",
  ];
  for (const result of outcome.results) {
    const marker = result.status === "pass" ? "[pass]" : result.status === "fail" ? "[FAIL]" : "[skip]";
    const timing = result.status === "skip" ? "" : ` (${result.durationMs} ms)`;
    lines.push(`${marker} ${result.id.padEnd(18)} ${result.title}${timing}`, `       ${result.detail}`);
    if (result.remedy) lines.push(`       -> ${result.remedy}`);
  }
  if (outcome.article) {
    lines.push(
      "",
      "可打开的文章链接",
      `  标题      ${outcome.article.title}`,
      `  API       ${outcome.article.apiUrl}`,
      `  文章页    ${outcome.article.webUrl}`,
      `  作品目录  ${outcome.article.archiveUrl}`,
    );
  }
  lines.push("", `${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed === 0 && passed > 0) {
    lines.push("发布链路已验证：注册（无邮箱）→ 作者资料 → 写作台发布 → 匿名 API 读 → Web SSR。");
  } else if (failed > 0) {
    lines.push("先修复 [FAIL] 项；它们按依赖顺序排列。");
  }
  return lines.join("\n");
}

function repositoryRoot(): string {
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

function waitForSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolveSignal();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.args) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const args = parsed.args;
  let stack: PortableStack | undefined;
  let tempDirectory: string | undefined;
  let apiBaseUrl = args.apiUrl ?? "";
  let webBaseUrl = args.webUrl ?? "";
  let mailEnvironment: Record<string, string | undefined> | undefined;
  const startedStack = apiBaseUrl.length === 0;

  try {
    if (startedStack) {
      tempDirectory = await mkdtemp(join(tmpdir(), "no-wave-verify-publish-"));
      const apiPort = await freePort();
      const webPort = await freePort();
      const options: StackOptions = {
        apiPort,
        webPort,
        databasePath: args.databasePath ?? join(tempDirectory, "verify.sqlite"),
        // siteUrl must match the Web origin the browser will address.
        siteUrl: `http://127.0.0.1:${webPort}`,
        jwtSecret: randomBytes(48).toString("hex"),
        repositoryRoot: repositoryRoot(),
      };
      stack = await startPortableStack(options);
      apiBaseUrl = stack.apiBaseUrl;
      webBaseUrl = stack.webBaseUrl;
      mailEnvironment = childEnvironment(portableStackEnvironment(options, "api"));
    }

    const outcome = await verifyPublish({
      apiBaseUrl,
      webBaseUrl,
      timeoutMs: args.timeoutMs,
      ...(mailEnvironment === undefined ? {} : { mailEnvironment }),
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        apiBaseUrl,
        webBaseUrl,
        startedStack,
        mail: startedStack ? "off" : "not-used",
        article: outcome.article ?? null,
        failed: outcome.failed,
        results: outcome.results,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatReport(outcome, { apiBaseUrl, webBaseUrl, startedStack })}\n`);
    }
    process.exitCode = outcome.failed === 0 ? 0 : 1;

    if (args.keep && stack) {
      process.stdout.write("\n--keep：栈仍在运行，按 Ctrl+C 停止并清理。\n");
      await waitForSignal();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`发布验证失败：${message}\n`);
    process.exitCode = 1;
  } finally {
    if (stack) await stopPortableStack(stack);
    if (tempDirectory && args.databasePath === undefined) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`发布验证失败：${message}\n`);
    process.exitCode = 1;
  });
}
