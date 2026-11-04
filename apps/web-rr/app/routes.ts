import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

/**
 * Explicit route table.
 *
 * The same module can serve two paths (the English article route reuses the
 * Chinese one) as long as the duplicate gets its own `id`; the locale is derived
 * from the request path inside the module, which is exactly the information the
 * Locale used to be carried by a differently-named directory, and still is.
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
  // The directory first: `/authors` is a collection (ADR 0024), and a reader who
  // asks for the index must not be routed into `/authors/:username`.
  route("authors", "routes/authors.tsx"),
  route("en/authors", "routes/authors.tsx", { id: "en-authors" }),
  route("authors/:username", "routes/author.tsx"),
  route("en/authors/:username", "routes/author.tsx", { id: "en-author" }),
  route("categories", "routes/categories.tsx"),
  route("en/categories", "routes/categories.tsx", { id: "en-categories" }),
  route("categories/:slug", "routes/category.tsx"),
  route("en/categories/:slug", "routes/category.tsx", { id: "en-category" }),
  route("search", "routes/search.tsx"),
  route("en/search", "routes/search.tsx", { id: "en-search" }),
  // 关注流（#198）：私有页，loader 只按 session marker 决定是否重定向到登录。
  route("feed", "routes/feed.tsx"),
  route("en/feed", "routes/feed.tsx", { id: "en-feed" }),
  route("articles/:slug", "routes/article.tsx"),
  route("en/articles/:slug", "routes/article.tsx", { id: "en-article" }),
  route("sign-in", "routes/sign-in.tsx"),
  // Password recovery and email verification (ADR 0014). They are in the table
  // whether or not mail is switched on: they render a notice when it is off,
  // which is the whole point of having the pages here at all.
  route("forgot-password", "routes/forgot-password.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
  route("verify-email", "routes/verify-email.tsx"),
  route("write", "routes/write.tsx"),
  route("write/media", "routes/write.media.tsx"),
  route("account", "routes/account.tsx"),
  route("admin/featured", "routes/admin.featured.tsx"),
  route("sitemap.xml", "routes/sitemap.xml.ts"),
  route("robots.txt", "routes/robots.txt.ts"),
  route("api/auth/:action", "routes/api.auth.ts"),
  route("api/authoring/session", "routes/api.authoring.session.ts"),
  route("api/authoring/profile", "routes/api.authoring.profile.ts"),
  // Devices: the collection is a read (list) and a write (end the others);
  // one device is ended by its id (ADR 0019).
  route("api/authoring/sessions", "routes/api.authoring.sessions.ts"),
  route("api/authoring/sessions/:id", "routes/api.authoring.sessions.$id.ts"),
  route("api/authoring/featured", "routes/api.authoring.featured.ts"),
  route("api/authoring/featured/candidates", "routes/api.authoring.featured.candidates.ts"),
  route("api/authoring/email-verification", "routes/api.authoring.email-verification.ts"),
route("api/authoring/password", "routes/api.authoring.password.ts"),
route("api/authoring/email", "routes/api.authoring.email.ts"),
route("api/authoring/notifications", "routes/api.authoring.notifications.ts"),
route("api/authoring/notifications/unread-count", "routes/api.authoring.notifications.unread-count.ts"),
route("api/authoring/notifications/read-all", "routes/api.authoring.notifications.read-all.ts"),
route("api/authoring/notifications/:id/read", "routes/api.authoring.notifications.$id.read.ts"),
  route("api/authoring/articles", "routes/api.authoring.articles.ts"),
  route("api/authoring/articles/:id", "routes/api.authoring.articles.$id.ts"),
  route("api/authoring/articles/:id/restore", "routes/api.authoring.articles.$id.restore.ts"),
  route("api/authoring/deleted-articles", "routes/api.authoring.deleted-articles.ts"),
  route("api/articles/:slug/comments", "routes/api.articles.comments.ts"),
  // 收藏与关注（#198）。两条都必须在这里登记：路由表是显式的，模块文件放
  // 在 routes/ 下而没有登记就只是一个不会被调用的普通文件——收藏在 #201 里
  // 正是这样漏掉的。
  route("api/articles/:slug/like", "routes/api.articles.$slug.like.ts"),
  route("api/authors/:userId", "routes/api.authors.$userId.ts"),
  route("api/users/:userId/follow", "routes/api.users.$userId.follow.ts"),
  // 关注流：关注关系的读侧。没有它，关注只是走到别人主页看一眼（#198）。
  route("api/feed", "routes/api.feed.ts"),
  route("api/media/:id", "routes/api.media.ts"),
  route("api/authoring/media", "routes/api.authoring.media.ts"),
  // One asset is deleted by id; the collection is both the upload target and the
  // author's library (ADR 0022).
  route("api/authoring/media/:id", "routes/api.authoring.media.$id.ts"),
] satisfies RouteConfig;
