import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * The migrated pages must ship their interactive halves.
 *
 * A page can be server-rendered perfectly and still be dead: if a `"use client"`
 * component is not in the client bundle, its markup arrives, nothing hydrates,
 * and every assertion that compares HTML — including `pnpm check:ssr-parity` —
 * stays green. React Router and the App Router build their client graphs
 * differently, so "it hydrates in Next.js" does not prove it hydrates here.
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
  { component: "ReaderToc", sentinel: "nw-toc", page: "articles/:slug" },
  { component: "ReadingProgress", sentinel: "nw-progress", page: "articles/:slug" },
  { component: "PageLoader", sentinel: "nw-load", page: "/" },
  { component: "HomeLatest", sentinel: "nw-more", page: "/" },
  { component: "HeroGlCanvas", sentinel: "precision highp float", page: "/" },
  // Phase 4b: the desk is the most client-heavy page in the product — a Lexical
  // editor behind a session — so "it renders" says the least about it here.
  { component: "AuthoringWorkspace", sentinel: "正在验证登录状态并载入草稿", page: "write" },
  { component: "ArticleEditor", sentinel: "作品地址（slug）由系统根据标题自动生成", page: "write" },
  // The desk's inbox. It is the only screen that can show a reader the notice a
  // deletion wrote them, and it renders nothing until it has fetched — so if it
  // is missing from the bundle, the desk still looks complete.
  { component: "NotificationInbox", sentinel: "/api/authoring/notifications/read-all", page: "write" },
  // The site shell, rendered by root.tsx on **every** page. It is the last
  // piece of the App Router's root layout to arrive here, and the easiest to
  // lose: with no shell a page still has a title, a status and a canonical URL,
  // so every other check in this file and in `pnpm check:ssr-parity` passes on a
  // page the visitor cannot navigate away from.
  { component: "SiteChrome", sentinel: "nw-smooth", page: "/" },
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
    "The prototype must be built before its tests run: pnpm --filter @bot-thk/web-rr build",
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
