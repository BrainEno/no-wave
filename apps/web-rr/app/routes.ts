import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

/**
 * Explicit route table.
 *
 * The same module can serve two paths (the English article route reuses the
 * Chinese one) as long as the duplicate gets its own `id`; the locale is derived
 * from the request path inside the module, which is exactly the information the
 * Next.js version got from a differently-named directory.
 */
export default [
  index("routes/home.tsx"),
  route("articles/:slug", "routes/article.tsx"),
  route("en/articles/:slug", "routes/article.tsx", { id: "en-article" }),
  route("sign-in", "routes/sign-in.tsx"),
  route("account", "routes/account.tsx"),
  route("api/auth/:action", "routes/api.auth.ts"),
] satisfies RouteConfig;
