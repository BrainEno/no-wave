import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

/**
 * Explicit route table.
 *
 * The same module can serve two paths (the English article route reuses the
 * Chinese one) as long as the duplicate gets its own `id`; the locale is derived
 * from the request path inside the module, which is exactly the information the
 * Next.js version got from a differently-named directory.
 *
 * Phase 3 adds the public SSR routes: archive, author, category index/detail and
 * search. Every one of them is a thin loader + a shared presentational
 * component; see `docs/roadmap/public-ssr-migration.md`.
 */
export default [
  index("routes/home.tsx"),
  route("en", "routes/home.tsx", { id: "en-home" }),
  route("articles", "routes/archive.tsx"),
  route("en/articles", "routes/archive.tsx", { id: "en-archive" }),
  route("authors/:username", "routes/author.tsx"),
  route("en/authors/:username", "routes/author.tsx", { id: "en-author" }),
  route("categories", "routes/categories.tsx"),
  route("en/categories", "routes/categories.tsx", { id: "en-categories" }),
  route("categories/:slug", "routes/category.tsx"),
  route("en/categories/:slug", "routes/category.tsx", { id: "en-category" }),
  route("search", "routes/search.tsx"),
  route("en/search", "routes/search.tsx", { id: "en-search" }),
  route("articles/:slug", "routes/article.tsx"),
  route("en/articles/:slug", "routes/article.tsx", { id: "en-article" }),
  route("sign-in", "routes/sign-in.tsx"),
  route("write", "routes/write.tsx"),
  route("account", "routes/account.tsx"),
  route("sitemap.xml", "routes/sitemap.xml.ts"),
  route("robots.txt", "routes/robots.txt.ts"),
  route("api/auth/:action", "routes/api.auth.ts"),
  route("api/authoring/session", "routes/api.authoring.session.ts"),
  route("api/authoring/articles", "routes/api.authoring.articles.ts"),
  route("api/authoring/articles/:id", "routes/api.authoring.articles.$id.ts"),
  route("api/articles/:slug/comments", "routes/api.articles.comments.ts"),
  route("api/media/:id", "routes/api.media.ts"),
  route("api/authoring/media", "routes/api.authoring.media.ts"),
] satisfies RouteConfig;
