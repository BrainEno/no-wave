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
  route("tags", "routes/tags.tsx"),
  route("en/tags", "routes/tags.tsx", { id: "en-tags" }),
  route("tags/:slug", "routes/tag.tsx"),
  route("en/tags/:slug", "routes/tag.tsx", { id: "en-tag" }),
  // React Router dynamic segments must occupy the complete segment. The
  // resource module accepts only feed.atom/feed.xml and privately rejects others.
  route("tags/:slug/:feed", "routes/tag-feed.ts"),
  route("en/tags/:slug/:feed", "routes/tag-feed.ts", { id: "en-tag-feed" }),
  route("search", "routes/search.tsx"),
  route("en/search", "routes/search.tsx", { id: "en-search" }),
  // 关注流（#198）：私有页，loader 只按 session marker 决定是否重定向到登录。
  route("feed", "routes/feed.tsx"),
  route("en/feed", "routes/feed.tsx", { id: "en-feed" }),
  // 私信读侧（#198）：与 /feed 同样的私有页模式——loader 只按 session marker
  // 决定是否重定向，内容由浏览器带着自己的 cookie 去取。
  route("messages", "routes/messages.tsx"),
  route("en/messages", "routes/messages.tsx", { id: "en-messages" }),
  route("messages/:id", "routes/messages.$id.tsx"),
  route("en/messages/:id", "routes/messages.$id.tsx", { id: "en-message-thread" }),
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
  route("write/notion", "routes/write.notion.tsx"),
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
  // Notion exchange (ADR 0036): the import is a `POST` to the API from the desk's
  // own client; the export is a download, so the browser needs a URL it can follow.
  route("api/authoring/notion-export", "routes/api.authoring.notion-export.ts"),
  route("api/authoring/notion-import", "routes/api.authoring.notion-import.ts"),
  route("api/articles/:slug/comments", "routes/api.articles.comments.ts"),
  // 评论编辑（ADR 0031）：单条评论按 id 寻址，和按 slug 寻址的评论区分开登记。
  route("api/comments/:id", "routes/api.comments.$id.ts"),
  // 收藏与关注（#198）。两条都必须在这里登记：路由表是显式的，模块文件放
  // 在 routes/ 下而没有登记就只是一个不会被调用的普通文件——收藏在 #201 里
  // 正是这样漏掉的。
  route("api/articles/:slug/like", "routes/api.articles.$slug.like.ts"),
  // 阅读数（ADR 0035）：页面挂载后发一次的信标。只有 action，没有 loader——
  // 一个 `GET` 不能让计数动，阅读是写。
  route("api/articles/:slug/views", "routes/api.articles.$slug.views.ts"),
  route("api/authors/:userId", "routes/api.authors.$userId.ts"),
  route("api/users/:userId/follow", "routes/api.users.$userId.follow.ts"),
  // 关注流：关注关系的读侧。没有它，关注只是走到别人主页看一眼（#198）。
  route("api/feed", "routes/api.feed.ts"),
  // Browser requests need the access cookie scoped to /api/authoring. Public
  // reads otherwise silently see an anonymous viewer, while private requests
  // unnecessarily rotate the refresh token. Keep the original paths for clients.
  // 评论的写路径同样要在 /api/authoring 下再登记一次（#242）：浏览器只会把
  // nw_access 发给这个前缀，否则每次发评都要先吃一个 401 再轮换刷新令牌。
  // 读仍然是公开的 /api/articles/:slug/comments，不动。
  route("api/authoring/articles/:slug/comments", "routes/api.articles.comments.ts", { id: "authoring-article-comments" }),
  route("api/authoring/comments/:id", "routes/api.comments.$id.ts", { id: "authoring-comment" }),
  route("api/authoring/articles/:slug/like", "routes/api.articles.$slug.like.ts", { id: "authoring-article-like" }),
  route("api/authoring/authors/:userId", "routes/api.authors.$userId.ts", { id: "authoring-author-profile" }),
  route("api/authoring/users/:userId/follow", "routes/api.users.$userId.follow.ts", { id: "authoring-user-follow" }),
  route("api/authoring/feed", "routes/api.feed.ts", { id: "authoring-feed" }),
  // 私信读侧（#198）：收件箱、单个会话、消息分页。三处都必须登记，否则模块
  // 只是躺在 routes/ 下的普通文件——#201 的收藏正是这样漏掉的。
  route("api/inbox", "routes/api.inbox.ts"),
  route("api/inbox/:id", "routes/api.inbox.$id.ts"),
  route("api/inbox/:id/messages", "routes/api.inbox.$id.messages.ts"),
  route("api/inbox/:id/read", "routes/api.inbox.$id.read.ts"),
  // Browser calls use the authoring prefix so the scoped access cookie is sent.
  // Keep the original /api/inbox endpoints for existing callers.
  route("api/authoring/inbox", "routes/api.inbox.ts", { id: "authoring-inbox" }),
  route("api/authoring/inbox/:id", "routes/api.inbox.$id.ts", { id: "authoring-inbox-item" }),
  route("api/authoring/inbox/:id/messages", "routes/api.inbox.$id.messages.ts", { id: "authoring-inbox-messages" }),
  route("api/authoring/inbox/:id/read", "routes/api.inbox.$id.read.ts", { id: "authoring-inbox-read" }),
  route("api/media/:id", "routes/api.media.ts"),
  route("api/authoring/media", "routes/api.authoring.media.ts"),
  // One asset is deleted by id; the collection is both the upload target and the
  // author's library (ADR 0022).
  route("api/authoring/media/:id", "routes/api.authoring.media.$id.ts"),
] satisfies RouteConfig;
