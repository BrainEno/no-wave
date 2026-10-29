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
import type { LinksFunction } from "react-router";
// Shared stylesheet from the existing Web app, emitted as a hashed asset by Vite
// instead of being copied into this package.
import globalStyles from "../../web/src/app/globals.css?url";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@400;500;700&family=Noto+Serif+SC:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap",
  },
  { rel: "stylesheet", href: globalStyles },
];

function Document({ children, lang = "zh-CN" }: { children: ReactNode; lang?: string }) {
  return (
    <html lang={lang}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <Meta />
        <Links />
      </head>
      <body>
        <p data-prototype-banner style={{ margin: 0, padding: "6px 16px", font: "12px/1.5 system-ui", letterSpacing: ".08em", textTransform: "uppercase", opacity: 0.6 }}>
          React Router 7 prototype · not the production site · `pnpm dev` in apps/web is still authoritative
        </p>
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
      <Outlet />
    </Document>
  );
}

/**
 * Error boundary for both hard 404s (thrown from loaders as `data(..., 404)`)
 * and unexpected failures. The status code is preserved: a missing article must
 * answer 404, never a soft 404 with a 200 status.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <Document lang="zh-CN">
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
    </Document>
  );
}
