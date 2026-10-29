/**
 * `pnpm check:ssr-parity` — side-by-side behavior comparison of the two Web
 * implementations: the Next.js App Router (`apps/web`) and the React Router
 * prototype (`apps/web-rr`).
 *
 * Phase 3's exit gate is "public routes pass side-by-side behavior assertions
 * with no known SEO, locale or hard-404 regression". Asserting that against a
 * written list is how the gate stops being a claim: both applications are built,
 * started on free ports and pointed at the **same** mock REST API, then every
 * migrated public route is fetched from both and compared on the things a
 * crawler or a visitor actually observes:
 *
 *   - HTTP status (including hard 404s for unknown entities);
 *   - `<title>`;
 *   - canonical URL and the hreflang alternate set;
 *   - presence of the route's content markers;
 *   - `Cache-Control` class (private responses must be `no-store` in both);
 *   - `sitemap.xml` URL sets and `robots.txt` text, compared exactly.
 *
 * One difference is reported but not failed (`KNOWN_DIVERGENCES` below, and in
 * more detail in docs/roadmap/public-ssr-migration.md §5): public pages are
 * shared-cacheable in the prototype but `private, no-store` in the App Router,
 * which is the migration's intent. Everything else fails the run — including a
 * canonical URL that points anywhere other than the configured origin, which is
 * what caught the App Router's home/archive pages canonicalising against the
 * `content.ts` fixture constant (now fixed by `configuredSiteUrl()`).
 *
 * Unlike `scripts/local-dev-check.ts`, this script *does* import app code — the
 * mock REST API — because the point is to compare two applications, not to probe
 * a deployment. One mock serves both, so a difference in the output cannot come
 * from a difference in the data.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { startMockRestApi, type MockRestApi } from "../apps/web-rr/mocks/rest-api.ts";

const SITE_URL = "https://no-wave.example";

type Expectation = {
  path: string;
  /** Content markers that must be present in both, or absent in both. */
  markers?: RegExp[];
  /** When true, both implementations must answer with a private (no-store) response. */
  private?: boolean;
};

const ROUTES: readonly Expectation[] = [
  { path: "/", markers: [/data-hero/, /可移植的文学基础设施/] },
  { path: "/en", markers: [/data-hero/, /A Portable Literary Foundation/] },
  { path: "/articles", markers: [/可移植的文学基础设施/, /作为抵抗的阅读/] },
  { path: "/articles?q=抵抗", markers: [/作为抵抗的阅读/] },
  { path: "/articles?type=short_story", markers: [/作为抵抗的阅读/] },
  { path: "/en/articles", markers: [/A Portable Literary Foundation/] },
  { path: "/articles/portable-web-foundation", markers: [/可移植的文学基础设施/] },
  { path: "/en/articles/portable-web-foundation", markers: [/A Portable Literary Foundation/] },
  { path: "/authors/writer", markers: [/可移植的文学基础设施/] },
  { path: "/en/authors/writer", markers: [/A Portable Literary Foundation/] },
  { path: "/categories", markers: [/随笔/] },
  { path: "/categories/essays", markers: [/可移植的文学基础设施/] },
  { path: "/en/categories", markers: [/Essays/] },
  { path: "/search?q=抵抗", markers: [/作为抵抗的阅读/], private: true },
  // Hard 404s are private responses in both implementations; only the `no-store`
  // class is compared, because the exact header spelling is framework-specific.
  { path: "/articles/does-not-exist", private: true },
  { path: "/authors/nobody", private: true },
  { path: "/categories/does-not-exist", private: true },
];

function runBuild(name: string, command: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const errors: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} build failed (exit ${code}):\n${errors.slice(-15).join("")}`));
    });
  });
}

function freePort(): Promise<number> {
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
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function startProcess(name: string, command: string[], cwd: string, env: NodeJS.ProcessEnv, detached: boolean): ChildProcess {
  const child = spawn(command[0] ?? "", command.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });
  const errors: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  child.stdout?.on("data", () => {});
  child.once("exit", (code) => {
    // `code === null` means the process was killed by a signal — this script
    // stops both servers itself, so that is not a failure worth reporting.
    if (code !== 0 && code !== null && errors.length > 0) {
      process.stderr.write(`${name} exited ${code}:\n${errors.slice(-20).join("")}\n`);
    }
  });
  return child;
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      await response.text();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`The server at ${url} did not become ready.`);
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 5_000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      // A negative pid kills the whole group: `pnpm start` spawns Next as a child.
      process.kill(child.pid !== undefined && child.pid > 0 ? -child.pid : child.pid ?? 0, "SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Remove `<script>` blocks before comparing content.
 *
 * React Router serializes the loader data into an inline script, so a naive
 * substring match can be satisfied by the *payload* rather than by rendered
 * markup — which would let a real rendering regression pass. Comparing the
 * visible HTML of both applications is the only symmetric rule.
 */
function stripScripts(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "");
}

type Snapshot = {
  status: number;
  cacheControl: string;
  title: string | null;
  canonical: string | null;
  alternates: string[];
  body: string;
};

async function snapshot(baseUrl: string, path: string): Promise<Snapshot> {
  const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
  const body = await response.text();
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control") ?? "",
    title: /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? null,
    canonical: /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/.exec(body)?.[1] ?? null,
    alternates: [...body.matchAll(/<link[^>]+rel="alternate"[^>]+hrefLang="([^"]+)"[^>]+href="([^"]+)"/g)]
      .map((match) => `${match[1]} ${match[2]}`)
      .sort(),
    body: stripScripts(body),
  };
}

type Difference = { path: string; check: string; next: string; rr: string; known?: string };

/**
 * Differences that are the point of the migration, or an App Router defect that
 * this branch is not allowed to fix on its own.
 *
 * Both entries are genuine behavioural differences — they are listed here so
 * the gate can fail on *new* divergence instead of on the two known ones, and
 * each entry carries the reason so the output stays self-explaining.
 */
const KNOWN_DIVERGENCES: readonly {
  reason: string;
  matches: (difference: Omit<Difference, "known">) => boolean;
}[] = [
  {
    // Caching is the migration's goal: a free instance that cold-starts needs a
    // shared cache in front of it, so public pages opt into `s-maxage` + SWR
    // while the App Router serves everything as private/no-store.
    reason: "public pages are shared-cacheable in the prototype but private/no-store in the App Router (intended)",
    matches: (d) => d.check === "cache-control" && d.next.includes("no-store") && d.rr.includes("s-maxage"),
  },
];

function compareScalar(path: string, check: string, next: unknown, rr: unknown, out: Difference[]): void {
  if (next === rr) return;
  const candidate = { path, check, next: `${next}`, rr: `${rr}` };
  const known = KNOWN_DIVERGENCES.find((entry) => entry.matches(candidate))?.reason;
  out.push(known ? { ...candidate, known } : candidate);
}

async function main(): Promise<number> {
  // `NEXT_PUBLIC_*` is inlined by Next.js at **build** time, so comparing a
  // prototype built with `NEXT_PUBLIC_SITE_URL` set against an App Router build
  // made without it would report every canonical URL as a difference while
  // proving nothing. Build both with the same origin first.
  process.stdout.write(`ssr-parity: building both applications with NEXT_PUBLIC_SITE_URL=${SITE_URL}\n`);
  await runBuild("apps/web", ["pnpm", "--filter", "@bot-thk/web", "build"], { NEXT_PUBLIC_SITE_URL: SITE_URL });
  await runBuild("apps/web-rr", ["pnpm", "--filter", "@bot-thk/web-rr", "build"], { NEXT_PUBLIC_SITE_URL: SITE_URL });
  process.stdout.write("ssr-parity: comparing\n");

  const mockApi: MockRestApi = await startMockRestApi();
  const nextPort = await freePort();
  const rrPort = await freePort();
  const sharedEnv = {
    ...process.env,
    API_BASE_URL: mockApi.url,
    API_SERVICE_URL: "",
    API_GRAPHQL_URL: "",
    NEXT_PUBLIC_SITE_URL: SITE_URL,
  };

  let nextServer: ChildProcess | undefined;
  let rrServer: ChildProcess | undefined;
  const differences: Difference[] = [];

  try {
    nextServer = startProcess("apps/web", ["pnpm", "--filter", "@bot-thk/web", "start"], process.cwd(), {
      ...sharedEnv,
      HOSTNAME: "127.0.0.1",
      PORT: String(nextPort),
    }, true);
    rrServer = startProcess("apps/web-rr", [process.execPath, "server.ts"], "apps/web-rr", {
      ...sharedEnv,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(rrPort),
    }, false);

    await Promise.all([
      waitForServer(`http://127.0.0.1:${nextPort}/`),
      waitForServer(`http://127.0.0.1:${rrPort}/`),
    ]);

    for (const route of ROUTES) {
      const [next, rr] = await Promise.all([
        snapshot(`http://127.0.0.1:${nextPort}`, route.path),
        snapshot(`http://127.0.0.1:${rrPort}`, route.path),
      ]);
      compareScalar(route.path, "status", next.status, rr.status, differences);
      compareScalar(route.path, "title", next.title, rr.title, differences);
      compareScalar(route.path, "canonical", next.canonical, rr.canonical, differences);
      compareScalar(route.path, "hreflang", next.alternates.join(","), rr.alternates.join(","), differences);
      if (route.private) {
        if (!/no-store/.test(next.cacheControl)) differences.push({ path: route.path, check: "cache-control(private)", next: next.cacheControl, rr: "expected no-store" });
        if (!/no-store/.test(rr.cacheControl)) differences.push({ path: route.path, check: "cache-control(private)", next: "expected no-store", rr: rr.cacheControl });
      } else {
        compareScalar(route.path, "cache-control", next.cacheControl, rr.cacheControl, differences);
      }
      for (const marker of route.markers ?? []) {
        compareScalar(route.path, `marker ${marker.source}`, marker.test(next.body), marker.test(rr.body), differences);
      }
    }

    // sitemap.xml and robots.txt are contracts, so they are compared exactly.
    const [nextSitemap, rrSitemap] = await Promise.all([
      (await fetch(`http://127.0.0.1:${nextPort}/sitemap.xml`)).text(),
      (await fetch(`http://127.0.0.1:${rrPort}/sitemap.xml`)).text(),
    ]);
    const locations = (xml: string): string[] =>
      [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "").sort();
    compareScalar("/sitemap.xml", "url count", locations(nextSitemap).length, locations(rrSitemap).length, differences);
    compareScalar("/sitemap.xml", "urls", locations(nextSitemap).join("\n"), locations(rrSitemap).join("\n"), differences);

    const [nextRobots, rrRobots] = await Promise.all([
      (await fetch(`http://127.0.0.1:${nextPort}/robots.txt`)).text(),
      (await fetch(`http://127.0.0.1:${rrPort}/robots.txt`)).text(),
    ]);
    compareScalar("/robots.txt", "text", nextRobots.trim(), rrRobots.trim(), differences);
  } finally {
    await stop(nextServer);
    await stop(rrServer);
    await mockApi.close();
  }

  for (const diff of differences) {
    process.stdout.write(
      `${diff.known ? "known" : "DIFF "}  ${diff.path}  ${diff.check}\n` +
        `        next: ${diff.next}\n        rr  : ${diff.rr}\n` +
        (diff.known ? `        why : ${diff.known}\n` : ""),
    );
  }

  const unexpected = differences.filter((diff) => !diff.known);
  const checked = ROUTES.length * 5 + ROUTES.reduce((sum, route) => sum + (route.markers?.length ?? 0), 0) + 3;
  process.stdout.write(
    `\nSSR parity: ${checked} comparisons over ${ROUTES.length} routes plus sitemap/robots; ` +
    `${unexpected.length} unexpected difference(s), ${differences.length - unexpected.length} known divergence(s).\n`,
  );
  if (unexpected.length === 0) {
    process.stdout.write("Both implementations agree on status, title, canonical, hreflang and content presence.\n");
  }
  return unexpected.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    // Explicit exit: the spawned servers and their keep-alive sockets can keep
    // the event loop alive after the comparison is done.
    process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`ssr-parity failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
