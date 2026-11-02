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
 * The site shell — top navigation, language switch, notification panel, the
 * smooth-scroll wrapper and the footer — is the shared client component
 * `SiteChrome` from `@bot-thk/web-ui`. It is the same shell every page is
 * rendered into, including 404s, so a dead link still arrives with a way out.
 *
 * It is a client component, so `apps/web-rr/test/client-bundle.test.ts` asserts
 * it is actually in the emitted client assets: markup that never hydrates is
 * invisible to every HTTP assertion.
 */
import { SiteChrome } from "@/components/chrome/site-chrome.tsx";
// The shared stylesheet, emitted as a hashed asset by Vite rather than copied.
import globalStyles from "../../../packages/web-ui/src/styles/globals.css?url";

export const links: LinksFunction = () => [
  // Declared explicitly so the browser fetches the icon we ship instead of
  // probing /favicon.ico on its own. React Router routes every path through the
  // router, so an undeclared icon used to arrive as a real request for
  // "/favicon.ico" and blow up as `No route matches URL "/favicon.ico"` on
  // every page load. Both files exist in public/ as well, because some clients
  // still ask for /favicon.ico regardless of what is declared here.
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "icon", type: "image/png", href: "/favicon.png", sizes: "256x256" },
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
 * has to see a 404 *and* a page that says so, while route-level `meta` is not
 * applied to error responses, so both are set here.
 */
export const headers: HeadersFunction = ({ errorHeaders }) =>
  errorHeaders ? { ...PRIVATE_PAGE_HEADERS } : {};

export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    // A dead link has to arrive with the same navigation as any other page —
    // otherwise the one page a visitor most needs a way out of has none.
    <Document lang="zh-CN" title={titleWithSite(notFound ? "404" : "服务暂时不可用")} robots="noindex, nofollow">
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
