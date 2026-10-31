import type { ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
} from "react-router";
import type { HeadersFunction, LinksFunction } from "react-router";
import { PRIVATE_PAGE_HEADERS } from "./lib/http-policy.ts";
import { titleWithSite } from "./lib/meta.ts";
/**
 * The site shell is the shared client component the App Router renders from its
 * root layout: top navigation, language switch, notification panel, the
 * smooth-scroll wrapper and the footer. Reusing it here is the point of the
 * alias seam — the prototype had no shell at all, which no title, status or
 * canonical comparison could see, because every one of those checks passes on a
 * page with no way to reach the rest of the site.
 *
 * It is a client component, so `apps/web-rr/test/client-bundle.test.ts` asserts
 * it is actually in the emitted client assets: markup that never hydrates is
 * invisible to every HTTP assertion.
 */
import { SiteChrome } from "@/components/chrome/site-chrome.tsx";
// Shared stylesheet from the existing Web app, emitted as a hashed asset by Vite
// instead of being copied into this package.
import globalStyles from "../../web/src/app/globals.css?url";

/**
 * Says which application this is, on every page, including 404s.
 *
 * It matters more now that the shell is here: with navigation, footer and
 * language switch in place the prototype can be mistaken for the site it is
 * about to replace.
 */
function PrototypeBanner() {
  return (
    <p data-prototype-banner style={{
      margin: 0,
      padding: "6px 16px",
      font: "12px/1.5 system-ui",
      letterSpacing: ".08em",
      textTransform: "uppercase",
      opacity: 0.6,
    }}>
      React Router 7 prototype · not the production site · `pnpm dev` in apps/web is still authoritative
    </p>
  );
}

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@400;500;700&family=Noto+Serif+SC:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap",
  },
  { rel: "stylesheet", href: globalStyles },
];

function Document({
  children,
  lang = "zh-CN",
  title,
  robots,
}: {
  children: ReactNode;
  lang?: string;
  title?: string;
  robots?: string;
}) {
  return (
    <html lang={lang}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {title ? <title>{title}</title> : null}
        {robots ? <meta name="robots" content={robots} /> : null}
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { pathname } = useLocation();
  return (
    <Document lang={pathname === "/en" || pathname.startsWith("/en/") ? "en" : "zh-CN"}>
      {/*
        Outside the shell on purpose: `SiteChrome` puts its children inside the
        smooth-scroll wrapper, and a banner that transforms with the page would
        follow the visitor down every scroll.
      */}
      <PrototypeBanner />
      <SiteChrome>
        <Outlet />
      </SiteChrome>
    </Document>
  );
}

/**
 * Error boundary for both hard 404s (thrown from loaders as `data(..., 404)`)
 * and unexpected failures. The status code is preserved: a missing article must
 * answer 404, never a soft 404 with a 200 status.
 *
 * The response is also private and titled: a crawler that follows a dead link
 * has to see a 404 *and* a page that says so (the App Router renders its
 * `not-found` title), while route-level `meta` is not applied to error
 * responses, so both are set here.
 */
export const headers: HeadersFunction = ({ errorHeaders }) =>
  errorHeaders ? { ...PRIVATE_PAGE_HEADERS } : {};

export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    // The App Router renders its not-found page inside the root layout, so a
    // dead link has to arrive with the same navigation as any other page —
    // otherwise the one page a visitor most needs a way out of has none.
    <Document lang="zh-CN" title={titleWithSite(notFound ? "404" : "服务暂时不可用")} robots="noindex, nofollow">
      <PrototypeBanner />
      <SiteChrome>
        <main className="nw-w" data-error-boundary={notFound ? "404" : "500"}>
          <h1 data-reveal>{notFound ? "这一页不存在" : "服务暂时不可用"}</h1>
          <p className="nw-ep">
            {notFound
              ? "链接可能已失效，或作品尚未发布。"
              : "请求处理失败，请稍后重试。若持续出现，请检查 API 服务是否在运行。"}
          </p>
          <p>
            <a className="nw-btn" href="/">返回首页</a>
          </p>
        </main>
      </SiteChrome>
    </Document>
  );
}
