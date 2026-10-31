/**
 * `pnpm stack:start` / `pnpm stack:check` — the whole product on standard Node.js.
 *
 *   pnpm stack:start                 run the stack until Ctrl+C
 *   pnpm stack:check [--json]        start, probe everything, stop, exit non-zero on failure
 *
 * This is Phase 6's first item made executable: *"Build the final Web image/package
 * from a clean checkout and start it with only documented environment variables."*
 *
 * What makes it different from `pnpm dev`:
 *
 *   - **No platform.** Every process is a plain `node …` child. No Vercel service
 *     binding, no daemon, no framework CLI, no adapter that only one host can run.
 *     `API_SERVICE_URL` and the `VERCEL_*` family are not merely unused — they are
 *     absent from the children's environment, and the report says so.
 *   - **Only documented variables.** The environment is assembled here, from
 *     names listed in `.env.example`; `scripts/portable-stack.test.ts` fails if a
 *     variable is added here without being documented there.
 *   - **Nothing inherited.** Children get the operating-system minimum (PATH,
 *     HOME, temp directories) plus the assembled variables — not the developer's
 *     shell. A stack that only works because somebody exported a secret is a
 *     stack that cannot be deployed.
 *   - **The React Router app, not the App Router.** The migration's target
 *     implementation is the one this starts.
 *
 * The probe walks the product the way a visitor does: register, sign in through
 * the Web tier's cookie boundary, write and publish, read the published page as
 * server-rendered HTML, comment as a second reader, and — when PostgreSQL is
 * configured — drain the notification outbox and read the notice it wrote.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type CheckStatus = "pass" | "fail" | "skip";

export type CheckResult = {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  remedy?: string;
  durationMs: number;
};

/**
 * Variables this stack is allowed to set. Every one of them must appear in
 * `.env.example` — that is asserted by `scripts/portable-stack.test.ts`, so
 * "runs with only documented configuration" is a property with a test rather
 * than a sentence in a README.
 */
export const PORTABLE_VARIABLES = [
  "DATABASE_PROVIDER",
  "DATABASE_PATH",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "AUTH_JWT_SECRET",
  "AUTH_JWT_ISSUER",
  "AUTH_JWT_AUDIENCE",
  "API_BASE_URL",
  "NEXT_PUBLIC_SITE_URL",
  "PORT",
  "HOST",
] as const;

/**
 * Variables that must never reach a child process.
 *
 * `API_SERVICE_URL` is Vercel's private service binding: the Web app falls back
 * to it when `API_BASE_URL` is unset, and a deployment that depends on it cannot
 * run anywhere else. Keeping it out of the environment — rather than setting it
 * to an empty string and hoping nothing reads it — is what makes "关掉
 * API_SERVICE_URL 一切照常" something this script demonstrates instead of claims.
 */
export const PLATFORM_VARIABLES = [
  "API_SERVICE_URL",
  "API_GRAPHQL_URL",
  "VERCEL",
  "VERCEL_URL",
  "VERCEL_ENV",
  "VERCEL_REGION",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

/**
 * The operating-system minimum a child process inherits.
 *
 * Everything else — including the developer's shell and any CI secret — is
 * dropped, because the point of this command is to prove the stack runs on what
 * it is told and nothing else.
 */
export const INHERITED_VARIABLES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "COMSPEC",
  "LANG",
  "LC_ALL",
] as const;

export type StackOptions = {
  /** Port the API listens on. */
  apiPort: number;
  /** Port the Web app listens on. */
  webPort: number;
  /** Absolute path of a disposable SQLite file. Ignored when `databaseUrl` is set. */
  databasePath: string;
  /** PostgreSQL DSN. When set, the notification outbox path is included. */
  databaseUrl?: string;
  /** Public origin, used for canonical URLs and the links in a mail. */
  siteUrl: string;
  /** At least 32 bytes. The API refuses to start with a short one. */
  jwtSecret: string;
  /** Repository root, so every path is resolved from the checkout, not the cwd. */
  repositoryRoot: string;
  /** Start the long-lived notification worker (PostgreSQL only). */
  worker?: boolean;
};

/**
 * The environment of one process.
 *
 * Deliberately flat and explicit: a deployment tool can read this function and
 * know exactly what a process needs.
 */
export function portableStackEnvironment(
  options: StackOptions,
  role: "api" | "web" | "worker",
): Record<string, string> {
  const postgres = typeof options.databaseUrl === "string" && options.databaseUrl.length > 0;
  const common: Record<string, string> = {
    DATABASE_PROVIDER: postgres ? "postgres" : "sqlite",
    AUTH_JWT_SECRET: options.jwtSecret,
    AUTH_JWT_ISSUER: options.siteUrl,
    AUTH_JWT_AUDIENCE: "no-wave",
  };
  if (postgres) {
    common.DATABASE_URL = options.databaseUrl ?? "";
    common.DATABASE_URL_UNPOOLED = options.databaseUrl ?? "";
  } else {
    common.DATABASE_PATH = options.databasePath;
  }

  if (role === "api") {
    return { ...common, PORT: String(options.apiPort), HOST: "127.0.0.1" };
  }
  if (role === "worker") {
    // The worker talks to the database only; it never listens (metrics stay off
    // unless a port is configured, which this stack does not do).
    return { ...common };
  }
  return {
    ...common,
    PORT: String(options.webPort),
    HOST: "127.0.0.1",
    API_BASE_URL: `http://127.0.0.1:${options.apiPort}`,
    NEXT_PUBLIC_SITE_URL: options.siteUrl,
  };
}

/** The complete environment a child process gets: OS minimum plus its role. */
export function childEnvironment(roleEnvironment: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of INHERITED_VARIABLES) {
    const value = process.env[name];
    if (typeof value === "string") inherited[name] = value;
  }
  for (const name of PLATFORM_VARIABLES) delete inherited[name];
  return { ...inherited, ...roleEnvironment };
}

export type ManagedProcess = {
  role: "api" | "web" | "worker" | "migrate" | "drain";
  child: ChildProcess;
  output: string[];
};

export type PortableStack = {
  options: StackOptions;
  apiBaseUrl: string;
  webBaseUrl: string;
  processes: ManagedProcess[];
};

function repositoryRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a port."));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function spawnManaged(
  role: ManagedProcess["role"],
  command: string[],
  cwd: string,
  env: Record<string, string>,
): ManagedProcess {
  const child = spawn(command[0] ?? "", command.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const managed: ManagedProcess = { role, child, output: [] };
  const record = (chunk: Buffer): void => {
    const text = chunk.toString();
    managed.output.push(text);
    if (managed.output.length > 40) managed.output.shift();
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  return managed;
}

async function waitForHttp(url: string, timeoutMs: number, processes: ManagedProcess[]): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const managed of processes) {
      if (managed.child.exitCode !== null) {
        throw new Error(`${managed.role} exited early (${managed.child.exitCode}):\n${managed.output.join("")}`);
      }
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      await response.text();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`${url} did not become ready within ${timeoutMs} ms.`);
}

function runOnce(
  role: ManagedProcess["role"],
  command: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const managed = spawnManaged(role, command, cwd, env);
    const timer = setTimeout(() => {
      managed.child.kill("SIGTERM");
      reject(new Error(`${role} timed out after ${timeoutMs} ms:\n${managed.output.join("")}`));
    }, timeoutMs);
    managed.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: managed.output.join("") });
    });
    managed.child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Build the React Router app, migrate the database and start the processes.
 *
 * The build is part of the command on purpose: `stack:start` has to work from a
 * clean checkout, where no `apps/web-rr/build` exists yet.
 */
export async function startPortableStack(options: StackOptions): Promise<PortableStack> {
  const root = options.repositoryRoot;
  const build = await runOnce(
    "migrate",
    ["pnpm", "--filter", "@bot-thk/web-rr", "build"],
    root,
    childEnvironment(portableStackEnvironment(options, "web")),
    300_000,
  );
  if (build.code !== 0) throw new Error(`The Web build failed:\n${build.output}`);

  const migrate = await runOnce(
    "migrate",
    [process.execPath, "src/persistence/migrate.ts"],
    join(root, "apps/api"),
    childEnvironment(portableStackEnvironment(options, "api")),
    120_000,
  );
  if (migrate.code !== 0) throw new Error(`The database migration failed:\n${migrate.output}`);

  const processes: ManagedProcess[] = [
    spawnManaged(
      "api",
      [process.execPath, "src/server.ts"],
      join(root, "apps/api"),
      childEnvironment(portableStackEnvironment(options, "api")),
    ),
    spawnManaged(
      "web",
      [process.execPath, "server.ts"],
      join(root, "apps/web-rr"),
      childEnvironment(portableStackEnvironment(options, "web")),
    ),
  ];

  const postgres = typeof options.databaseUrl === "string" && options.databaseUrl.length > 0;
  if (options.worker === true && postgres) {
    processes.push(
      spawnManaged(
        "worker",
        [process.execPath, "src/persistence/notification-worker.ts"],
        join(root, "apps/api"),
        childEnvironment(portableStackEnvironment(options, "worker")),
      ),
    );
  }

  const apiBaseUrl = `http://127.0.0.1:${options.apiPort}`;
  const webBaseUrl = `http://127.0.0.1:${options.webPort}`;
  await waitForHttp(`${apiBaseUrl}/health`, 60_000, processes);
  await waitForHttp(`${webBaseUrl}/`, 60_000, processes);
  return { options, apiBaseUrl, webBaseUrl, processes };
}

export async function stopPortableStack(stack: PortableStack): Promise<void> {
  await Promise.all(
    stack.processes.map(
      (managed) =>
        new Promise<void>((resolve) => {
          if (managed.child.exitCode !== null) {
            resolve();
            return;
          }
          managed.child.once("exit", () => resolve());
          managed.child.kill("SIGTERM");
        }),
    ),
  );
}

type StepOutcome = { status: CheckStatus; detail: string; remedy?: string };

async function step(
  id: string,
  title: string,
  run: () => Promise<StepOutcome>,
  results: CheckResult[],
): Promise<void> {
  const startedAt = Date.now();
  try {
    const outcome = await run();
    results.push({ id, title, ...outcome, durationMs: Date.now() - startedAt });
  } catch (error) {
    results.push({
      id,
      title,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return parseJson(await response.text());
}

function dataOf(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const data = payload?.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

/** `Set-Cookie` as a request header, in the shape every browser sends it back. */
function cookieHeader(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const pairs = cookies.map((cookie) => cookie.split(";")[0] ?? "").filter((pair) => pair.length > 0);
  return pairs.join("; ");
}

const TIMEOUT_MS = 20_000;

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
}

/**
 * Walk the product over HTTP, in the order a developer debugs it.
 *
 * Every assertion uses the public contract only: no application code is
 * imported, so this probe verifies a SQLite file and a managed PostgreSQL
 * instance exactly the same way.
 */
export async function probePortableStack(stack: PortableStack): Promise<CheckResult[]> {
  const { apiBaseUrl, webBaseUrl } = stack;
  const results: CheckResult[] = [];
  const postgres = typeof stack.options.databaseUrl === "string" && stack.options.databaseUrl.length > 0;
  const identity = {
    email: `portable-${Date.now().toString(36)}@example.test`,
    password: "portable-stack-password",
  };
  const reader = {
    email: `reader-${Date.now().toString(36)}@example.test`,
    password: "portable-stack-password",
  };

  await step("api.health", "API process answers", async () => {
    const response = await request(`${apiBaseUrl}/health`);
    return response.status === 200
      ? { status: "pass", detail: "GET /health → 200" }
      : { status: "fail", detail: `GET /health → ${response.status}`, remedy: "Start the API with the documented DATABASE_* and AUTH_JWT_* variables." };
  }, results);

  await step("api.ready", "API reached the database", async () => {
    const response = await request(`${apiBaseUrl}/ready`);
    return response.status === 200
      ? { status: "pass", detail: "GET /ready → 200" }
      : { status: "fail", detail: `GET /ready → ${response.status}`, remedy: "The migrations did not run, or the database is unreachable." };
  }, results);

  await step("web.home", "Web app renders server-side", async () => {
    const response = await request(`${webBaseUrl}/`);
    const body = await response.text();
    if (response.status !== 200) return { status: "fail", detail: `GET / → ${response.status}` };
    if (!/<title>/.test(body)) return { status: "fail", detail: "the home page has no <title>" };
    if (!/class="nw-pill"/.test(body)) return { status: "fail", detail: "the page rendered without the site shell" };
    return { status: "pass", detail: "GET / → 200 with a title and the site shell" };
  }, results);

  let authorCookies = "";
  let authorId = "";
  let readerToken = "";
  let readerCookies = "";

  await step("identity.register", "Registration against the API", async () => {
    const response = await request(`${apiBaseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(identity),
    });
    const data = dataOf(await readJson(response));
    const accessToken = typeof data?.accessToken === "string" ? data.accessToken : "";
    if (response.status !== 201 || accessToken.length === 0) {
      return { status: "fail", detail: `POST /api/v1/auth/register → ${response.status}` };
    }
    const profile = await request(`${apiBaseUrl}/api/v1/me/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, origin: apiBaseUrl },
      body: JSON.stringify({ displayName: "可移植作者", bio: "标准 Node 进程里创建的账号。", locale: "zh-CN" }),
    });
    if (profile.status !== 200) {
      return { status: "fail", detail: `the account registered but PUT /api/v1/me/profile → ${profile.status}` };
    }
    const second = await request(`${apiBaseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reader),
    });
    if (second.status !== 201) return { status: "fail", detail: `the second account → ${second.status}` };
    const readerData = dataOf(await readJson(second));
    readerToken = typeof readerData?.accessToken === "string" ? readerData.accessToken : "";
    if (readerToken.length === 0) return { status: "fail", detail: "the second account registered without an access token" };

    // The author's user id is what a direct message is addressed to; the outbox
    // carries conversation messages, not comments.
    const me = await request(`${apiBaseUrl}/api/v1/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    const meData = dataOf(await readJson(me));
    const id = typeof meData?.id === "string" ? meData.id : "";
    if (me.status !== 200 || id.length === 0) {
      return { status: "fail", detail: `GET /api/v1/me → ${me.status} (no user id)` };
    }
    authorId = id;
    return { status: "pass", detail: "two accounts registered and the author's profile was created" };
  }, results);

  await step("web.auth", "Web auth proxy sets HttpOnly cookies", async () => {
    const response = await request(`${webBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: webBaseUrl },
      body: JSON.stringify(identity),
    });
    const body = await response.text();
    const cookies = cookieHeader(response);
    if (response.status !== 200 || cookies.length === 0) {
      return { status: "fail", detail: `POST /api/auth/login → ${response.status} (no cookie)`, remedy: "The Web tier needs API_BASE_URL; it cannot inherit a platform binding." };
    }
    if (/"accessToken"/.test(body)) {
      return { status: "fail", detail: "the response carried a token; cookies only" };
    }
    authorCookies = cookies;
    const session = await request(`${webBaseUrl}/api/authoring/session`, { headers: { cookie: cookies } });
    if (session.status !== 200) return { status: "fail", detail: `GET /api/authoring/session → ${session.status}` };
    return { status: "pass", detail: "login set HttpOnly cookies, the session resolves, no token in the body" };
  }, results);

  let slug = "";
  await step("web.authoring", "Writing desk publishes through the Web tier", async () => {
    const created = await request(`${webBaseUrl}/api/authoring/articles`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: webBaseUrl, cookie: authorCookies },
      body: JSON.stringify({
        title: "标准 Node 上的一篇文章",
        contentBlocksVersion: 0,
        // The application-owned block document: an `id` per block, plain text at
        // version 0, no Lexical in sight.
        contentBlocks: [{ id: "portable-1", type: "paragraph", text: "这一段用来验证发布链路：从写作台到公开页面。" }],
        publish: true,
      }),
    });
    // Read the body once: a `Response` can only be consumed one way, and the
    // failure message needs the same bytes the success path parses.
    const body = await created.text();
    const data = dataOf(parseJson(body));
    const value = typeof data?.slug === "string" ? data.slug : "";
    if (created.status !== 201 || value.length === 0) {
      return {
        status: "fail",
        detail: `POST /api/authoring/articles → ${created.status} ${body.slice(0, 200)}`,
        remedy: "The authoring proxy needs API_BASE_URL and a session cookie scoped to /api/authoring.",
      };
    }
    slug = value;
    return { status: "pass", detail: `published /articles/${value}` };
  }, results);

  await step("web.article", "The published page is server-rendered HTML", async () => {
    if (slug.length === 0) return { status: "skip", detail: "no article was published" };
    const response = await request(`${webBaseUrl}/articles/${slug}`);
    const body = await response.text();
    if (response.status !== 200) return { status: "fail", detail: `GET /articles/${slug} → ${response.status}` };
    if (!body.includes("标准 Node 上的一篇文章")) {
      return { status: "fail", detail: "the page rendered without the article body" };
    }
    return { status: "pass", detail: `GET /articles/${slug} → 200 with the title and body in the HTML` };
  }, results);

  await step("web.comments", "A second reader comments through the Web tier", async () => {
    if (slug.length === 0) return { status: "skip", detail: "no article was published" };
    const login = await request(`${webBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: webBaseUrl },
      body: JSON.stringify(reader),
    });
    readerCookies = cookieHeader(login);
    if (login.status !== 200) return { status: "fail", detail: `the reader could not sign in (${login.status})` };
    const posted = await request(`${webBaseUrl}/api/articles/${slug}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: webBaseUrl, cookie: readerCookies },
      body: JSON.stringify({ content: "这篇是在可移植栈里发出的评论。" }),
    });
    if (posted.status !== 201) {
      return { status: "fail", detail: `POST /api/articles/${slug}/comments → ${posted.status}` };
    }
    const listed = await request(`${webBaseUrl}/api/articles/${slug}/comments`);
    const body = await listed.text();
    if (!body.includes("这篇是在可移植栈里发出的评论。")) {
      return { status: "fail", detail: "the comment was created but is not readable" };
    }
    return { status: "pass", detail: "comment created and read back through the same-origin proxy" };
  }, results);

  /** The author's inbox, read through the Web tier's same-origin proxy. */
  const inboxCount = async (): Promise<number> => {
    const response = await request(`${webBaseUrl}/api/authoring/notifications`, { headers: { cookie: authorCookies } });
    if (response.status !== 200) return -1;
    const data = dataOf(await readJson(response));
    return Array.isArray(data?.notifications) ? data.notifications.length : -1;
  };

  await step("outbox.drain", "Notification outbox drains outside the Web server", async () => {
    if (!postgres) {
      return {
        status: "skip",
        detail: "the durable outbox is a PostgreSQL table; set DATABASE_URL to include this path",
      };
    }
    if (authorId.length === 0 || readerToken.length === 0) {
      return { status: "fail", detail: "the registration step did not record both accounts" };
    }
    // The durable outbox carries `message.created` events — direct messages, not
    // comments — so the reader opens a conversation with the author and writes
    // into it. Both writes require an Idempotency-Key: opening a conversation is
    // not idempotent.
    const opened = await request(`${apiBaseUrl}/api/v1/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${readerToken}`, "idempotency-key": "portable-stack-conversation" },
      body: JSON.stringify({ participantIds: [authorId] }),
    });
    const openedData = dataOf(await readJson(opened));
    const conversationId = typeof openedData?.id === "string" ? openedData.id : "";
    if (opened.status !== 201 || conversationId.length === 0) {
      return { status: "fail", detail: `POST /api/v1/conversations → ${opened.status} ${openedData ? JSON.stringify(openedData).slice(0, 200) : ""}` };
    }
    const message = await request(`${apiBaseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${readerToken}`, "idempotency-key": "portable-stack-message" },
      body: JSON.stringify({ body: "这条私信用来验证通知外箱：它必须由 Web 之外的进程投递。" }),
    });
    if (message.status !== 201) {
      return { status: "fail", detail: `POST /api/v1/conversations/:id/messages → ${message.status}`, remedy: "The outbox is written inside the message transaction; check the PostgreSQL insert." };
    }

    const inboxBefore = await inboxCount();
    const drain = await runOnce(
      "drain",
      [process.execPath, "src/persistence/notification-drain.ts"],
      join(stack.options.repositoryRoot, "apps/api"),
      childEnvironment(portableStackEnvironment(stack.options, "worker")),
      60_000,
    );
    if (drain.code !== 0) return { status: "fail", detail: `the drain exited ${drain.code}:\n${drain.output}` };
    const inboxAfter = await inboxCount();
    if (inboxAfter === 0) {
      return {
        status: "fail",
        detail: `the drain ran but the author's inbox is empty (before: ${inboxBefore})`,
        remedy: "The outbox only carries message.created events; check OUTBOX_* bounds, the lease and the drain deadline.",
      };
    }
    return {
      status: "pass",
      detail: `one drain delivered the direct message: the author's inbox went from ${inboxBefore} to ${inboxAfter} notice(s), outside the Web server`,
    };
  }, results);

  await step("no-platform", "No platform binding is present", async () => {
    const leaked = PLATFORM_VARIABLES.filter((name) => {
      const value = childEnvironment(portableStackEnvironment(stack.options, "web"))[name];
      return typeof value === "string" && value.length > 0;
    });
    if (leaked.length > 0) {
      return { status: "fail", detail: `${leaked.join(", ")} reached the Web process` };
    }
    return {
      status: "pass",
      detail: `${PLATFORM_VARIABLES.length} platform variables absent; the Web tier resolves the API through API_BASE_URL alone`,
    };
  }, results);

  return results;
}

export function formatReport(results: CheckResult[], stack: PortableStack): string {
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const skipped = results.filter((result) => result.status === "skip").length;
  const lines = ["", "Portable stack report", "=====================", `api  ${stack.apiBaseUrl}`, `web  ${stack.webBaseUrl}`, ""];
  for (const result of results) {
    const marker = result.status === "pass" ? "[pass]" : result.status === "fail" ? "[FAIL]" : "[skip]";
    const timing = result.status === "skip" ? "" : ` (${result.durationMs} ms)`;
    lines.push(`${marker} ${result.id.padEnd(18)} ${result.title}${timing}`, `       ${result.detail}`);
    if (result.remedy) lines.push(`       -> ${result.remedy}`);
  }
  lines.push("", `${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed === 0 && passed > 0) {
    lines.push("The stack runs on standard Node.js with only the documented environment variables.");
  } else if (failed > 0) {
    lines.push("Fix the [FAIL] entries first; they are ordered from the lowest layer to the highest.");
  }
  return lines.join("\n");
}

export type StackArguments = {
  keep: boolean;
  json: boolean;
  /** Start the long-lived notification worker instead of relying on the drain. */
  worker: boolean;
  databaseUrl: string | null;
  databasePath: string | null;
};

export function parseArguments(argv: readonly string[]): { args: StackArguments } | { error: string } {
  let keep = false;
  let json = false;
  let worker = false;
  let databaseUrl: string | null = null;
  let databasePath: string | null = null;
  for (const argument of argv) {
    if (argument === "--keep") keep = true;
    else if (argument === "--json") json = true;
    else if (argument === "--worker") worker = true;
    else if (argument.startsWith("--database-url=")) databaseUrl = argument.slice("--database-url=".length);
    else if (argument.startsWith("--database-path=")) databasePath = argument.slice("--database-path=".length);
    else return { error: `Unknown argument: ${argument}\nUsage: pnpm stack:check [--keep] [--json] [--worker] [--database-url=DSN] [--database-path=FILE]` };
  }
  return { args: { keep, json, worker, databaseUrl, databasePath } };
}

/**
 * The signing secret, or a random one for this run.
 *
 * Sessions do not survive a restart with a generated secret, which is the point:
 * a disposable stack should start with one command, and a deployment that needs
 * durable sessions has to say so by setting `AUTH_JWT_SECRET`. The operator is
 * told through `warn` rather than by writing to stdout, so this is testable
 * without capturing the process output.
 */
export function resolveJwtSecret(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (): void => {},
): string {
  const supplied = env.AUTH_JWT_SECRET;
  if (typeof supplied === "string" && supplied.length >= 32) return supplied;
  warn(
    "AUTH_JWT_SECRET was not set: a random secret was generated for this run, so no session survives a restart.",
  );
  return randomBytes(48).toString("hex");
}

export async function defaultOptions(overrides: Partial<StackOptions> = {}): Promise<StackOptions> {
  const secret = resolveJwtSecret(process.env, (message) => process.stdout.write(`${message}\n`));
  // A documented `DATABASE_PATH` is honoured; otherwise every run gets a
  // throwaway file so two stacks — or one developer and one CI job — never
  // share state by accident.
  const configuredPath = typeof process.env.DATABASE_PATH === "string" && process.env.DATABASE_PATH.length > 0
    ? process.env.DATABASE_PATH
    : "";
  const databasePath = overrides.databasePath ??
    (configuredPath.length > 0
      ? configuredPath
      : `${await mkdtemp(join(tmpdir(), "no-wave-portable-"))}/stack.sqlite`);
  return {
    apiPort: overrides.apiPort ?? (await freePort()),
    webPort: overrides.webPort ?? (await freePort()),
    databasePath,
    ...(overrides.databaseUrl !== undefined ? { databaseUrl: overrides.databaseUrl } : {}),
    ...(typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0
      ? { databaseUrl: process.env.DATABASE_URL }
      : {}),
    siteUrl: overrides.siteUrl ?? "http://127.0.0.1:3100",
    jwtSecret: secret,
    repositoryRoot: overrides.repositoryRoot ?? repositoryRoot(),
    ...(overrides.worker !== undefined ? { worker: overrides.worker } : {}),
  };
}

/**
 * Escape a value for a GitHub Actions workflow command.
 *
 * Newlines and carriage returns have to be encoded or the annotation would be
 * cut at the first line break, which is exactly where the useful detail lives.
 */
function escapeAnnotationData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").slice(0, 900);
}

/**
 * Surface every non-passing check in the GitHub UI.
 *
 * A red CI job whose reason is only in the log is a job nobody reads; an
 * annotation puts the failing step and its remedy on the pull request itself.
 */
export function annotationLines(results: CheckResult[], message = ""): string[] {
  if (process.env.GITHUB_ACTIONS !== "true") return [];
  const lines: string[] = [];
  if (message.length > 0) {
    lines.push(`::error title=portable-stack::${escapeAnnotationData(message)}`);
  }
  for (const result of results) {
    if (result.status === "pass") continue;
    const detail = `${result.detail}${result.remedy ? ` Remedy: ${result.remedy}` : ""}`;
    const level = result.status === "fail" ? "error" : "notice";
    lines.push(`::${level} title=portable-stack/${result.id}::${escapeAnnotationData(detail)}`);
  }
  return lines;
}

export function annotateResults(results: CheckResult[], message?: string): void {
  for (const line of annotationLines(results, message ?? "")) process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const { args } = parsed;
  const options = await defaultOptions({
    ...(args.databaseUrl !== null ? { databaseUrl: args.databaseUrl } : {}),
    ...(args.databasePath !== null ? { databasePath: args.databasePath } : {}),
    // The cardless path is a scheduler-invoked one-shot drain, so that — not a
    // long-lived worker — is what the default run proves. `--worker` starts the
    // worker a self-hosted deployment would run.
    worker: args.worker,
  });
  options.siteUrl = `http://127.0.0.1:${options.webPort}`;

  let stack: PortableStack | undefined;
  try {
    stack = await startPortableStack(options);
    if (args.keep) {
      process.stdout.write(`\napi  ${stack.apiBaseUrl}\nweb  ${stack.webBaseUrl}\nCtrl+C stops both processes.\n`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
      });
      return;
    }
    const results = await probePortableStack(stack);
    const failed = results.filter((result) => result.status === "fail").length;
    annotateResults(results);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ apiBaseUrl: stack.apiBaseUrl, webBaseUrl: stack.webBaseUrl, results }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatReport(results, stack)}\n`);
    }
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    if (stack) await stopPortableStack(stack);
    if (args.databasePath === null && options.databasePath.includes("no-wave-portable-")) {
      await rm(options.databasePath.replace(/\/stack\.sqlite$/, ""), { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`The portable stack failed: ${message}\n`);
    annotateResults([], `the stack did not come up: ${message}`);
    process.exitCode = 1;
  });
}
