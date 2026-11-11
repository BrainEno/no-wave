import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * The migrated pages must ship their interactive halves.
 *
 * A page can be server-rendered perfectly and still be dead: if a client
 * component is not in the client bundle, its markup arrives, nothing hydrates,
 * and every assertion that compares HTML stays green. The check therefore looks
 * at the emitted assets rather than at the response.
 *
 * The check is deliberately crude — a string that only exists in a component's
 * client-side code must appear in the emitted client assets. It cannot prove that
 * hydration succeeds (that needs a browser), but it proves the code is there:
 * the failure it catches is the one HTML comparison never can.
 */

const assetsDir = new URL("../build/client/assets/", import.meta.url);

type ClientComponent = {
  /** The shared client component. */
  component: string;
  /** A string literal that only appears in its client-side code. */
  sentinel: string;
  /** A migrated page that renders it. */
  page: string;
};

const CLIENT_COMPONENTS: readonly ClientComponent[] = [
  { component: "ArticleComments", sentinel: "/comments?locale=", page: "articles/:slug" },
  { component: "ReaderBar", sentinel: "nw-fs", page: "articles/:slug" },
  // Read-aloud renders nothing until an effect has asked the browser whether it
  // can speak at all, so an HTML check can never see it; without this the
  // article page could lose 朗读 and every server-side assertion would stay
  // green. The sentinel is the platform API the component itself detects.
  { component: "ReadAloud", sentinel: "speechSynthesis", page: "articles/:slug" },
  // Reading marks likewise render nothing until an effect has asked whether the
  // browser can paint them at all, and the paint itself leaves no markup to compare.
  { component: "PassageAnnotations", sentinel: "nw-passages-v1:", page: "articles/:slug" },
  { component: "ReaderToc", sentinel: "nw-toc", page: "articles/:slug" },
  { component: "ReadingProgress", sentinel: "nw-progress", page: "articles/:slug" },
  { component: "PageLoader", sentinel: "nw-load", page: "/" },
  { component: "HomeLatest", sentinel: "nw-more", page: "/" },
  { component: "HeroGlCanvas", sentinel: "precision highp float", page: "/" },
  // Phase 4b: the desk is the most client-heavy page in the product — a Lexical
  // editor behind a session — so "it renders" says the least about it here.
  { component: "AuthoringWorkspace", sentinel: "正在验证登录状态并载入草稿", page: "write" },
  // The library is a page of its own behind the desk, and everything on it
  // arrives after hydration — an HTML check would see an empty shell and pass.
  { component: "MediaLibrary", sentinel: "还没有上传过图片", page: "write/media" },
  { component: "ArticleEditor", sentinel: "作品地址（slug）由系统根据标题自动生成", page: "write" },
  // The Notion import (ADR 0036, phase 4). The page is a file picker and nothing
  // else until a file is chosen, so an HTML check would see a heading and a
  // button and pass; the sentinel is the request only this panel makes.
  { component: "NotionImport", sentinel: "/api/authoring/notion-import", page: "write/notion" },
  // The desk's inbox. It is the only screen that can show a reader the notice a
  // deletion wrote them, and it renders nothing until it has fetched — so if it
  // is missing from the bundle, the desk still looks complete.
  { component: "NotificationInbox", sentinel: "/api/authoring/notifications/read-all", page: "write" },
  // The site shell, rendered by root.tsx on **every** page, and the easiest to
  // lose: with no shell a page still has a title, a status and a canonical URL,
  // so every HTTP-level check passes on a page the visitor cannot navigate away
  // from.
  { component: "SiteChrome", sentinel: "nw-smooth", page: "/" },
  { component: "StartConversation", sentinel: "/api/authoring/inbox", page: "/messages" },
  { component: "ThreadView (reply)", sentinel: "nw-compose-body", page: "/messages/:id" },
  // The device list on the account page renders only after it has fetched, so
  // an HTML check on `/account` can never see it: without this the panel could
  // ship without its devices and every server-side assertion would stay green.
  { component: "AccountPanel (devices)", sentinel: "/api/authoring/sessions", page: "account" },
  // Recovery and verification. Each of these renders a form or a panel that
  // does its work in the browser — the verification panel spends the token from
  // an effect, so a page that renders it and never hydrates would sit on
  // "正在确认" forever while every HTTP assertion stayed green.
  { component: "ForgotPasswordForm", sentinel: "发送重设链接", page: "forgot-password" },
  { component: "ResetPasswordForm", sentinel: "确认新密码", page: "reset-password" },
  { component: "VerifyEmailPanel", sentinel: "邮箱已验证", page: "verify-email" },
];

function clientBundle(): string {
  assert.ok(
    existsSync(assetsDir),
    "The Web application must be built before its tests run: pnpm --filter @bot-thk/web-rr build",
  );
  const files = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
  assert.ok(files.length > 0, "the build emitted no client assets at all");
  return files.map((name) => readFileSync(new URL(name, assetsDir), "utf8")).join("\n");
}

test("every client component of a migrated page is present in the client bundle", () => {
  const bundle = clientBundle();
  for (const { component, sentinel, page } of CLIENT_COMPONENTS) {
    assert.ok(
      bundle.includes(sentinel),
      `${component} (rendered by ${page}) is missing from the client bundle — the page would render and never hydrate`,
    );
  }
});

/**
 * `meta` is not a server-only export.
 *
 * React Router's `<Meta />` calls the route module's `meta` in the browser too
 * — on hydration and on every client-side navigation — so anything `meta` reads
 * has to exist there. Reading `SITE_URL` out of `process.env` inside `meta`
 * threw `ReferenceError: process is not defined` in development, and in the
 * production build, where Vite substitutes `{}` for an unresolvable
 * `process.env`, it quietly emitted `https://example.invalid` canonical and
 * Open Graph URLs instead. The site origin now travels through the root
 * loader's data, so the browser never has to touch `process`.
 *
 * The assertion is on the emitted bundle rather than on the source because the
 * mistake is only visible there: a route module can import a server-only helper
 * and every server-side assertion stays green.
 */
test("no client asset reads the site origin from the environment", () => {
  const bundle = clientBundle();
  // `NEXT_PUBLIC_SITE_URL` is the sentinel that matters, not `process.env`:
  // Vite substitutes `{}` for an unresolvable `process.env` in the production
  // build, so the original mistake shipped as `(void 0).NEXT_PUBLIC_SITE_URL`
  // rather than as a literal `process.env` — a check for the literal would
  // have stayed green while canonical and Open Graph URLs went to
  // `https://example.invalid`.
  for (const name of ["NEXT_PUBLIC_SITE_URL", "process.env"]) {
    assert.ok(
      !bundle.includes(name),
      `${name} reached the client bundle. Route \`meta\` runs in the browser, so the site origin has to arrive through the root loader's data, not be read from the environment.`,
    );
  }
});

test("SSR build's external packages are declared as Web production dependencies", async () => {
  // A locally hoisted root devDependency can satisfy an SSR import during
  // testing, yet the production image installs only the Web workspace. Check
  // the actual emitted entry, not just imports in the pre-bundled source.
  const { builtinModules } = await import("node:module");
  const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  const server = readFileSync(new URL("../build/server/index.js", import.meta.url), "utf8");
  const imports = [...server.matchAll(/^import\s+.+?\s+from\s+["']([^"']+)["'];?$/gm)].map((match) => match[1]!);
  assert.ok(imports.length > 0, "the built server entry must contain external imports");
  for (const specifier of imports) {
    if (builtins.has(specifier) || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    const pieces = specifier.split("/");
    const packageName = specifier.startsWith("@") ? pieces.slice(0, 2).join("/") : pieces[0]!;
    assert.ok(manifest.dependencies[packageName], `${specifier} is external in the server build but ${packageName} is not a Web runtime dependency`);
  }
});
