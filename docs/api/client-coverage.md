# 客户端接口覆盖度检查

**目的**：回答两个问题——服务端 `/api/v1` 是否已经覆盖 Flutter 移动客户端
([BrainEno/flutter-blog](https://github.com/BrainEno/flutter-blog)) 的全部接口需求，以及它是否同时满足当前两个前端（Next.js `apps/web`、React Router `apps/web-rr`）的需求。

**结论（摘要）**：

- **路由级覆盖 30/30**：Flutter 客户端调用的 30 个 `client.*Json` 调用点，每一个都能在 `apps/api/src/transport/rest/routes.ts` 的路由表里找到对应项，且请求/响应字段与 `apps/api` 的序列化器一致。
- **当前前端无缺口**：两个前端通过 `packages/web-http` 只使用 9 个接口族，全部已实现。
- **真实缺口 4 项 + 2 项观察**：见下方「缺口清单」。其中 P1（登录状态下修改密码）已在本轮实现，P3 已给出结论（不是缺陷，是语义需要写清楚）。

**检查方法（以及没有做什么）**：静态交叉核对。把 Flutter 客户端 `lib/core/nowave/nowave_api_client.dart` 与 5 个 remote data source 里的全部调用点逐一列出，再对照 `routes.ts`（43 个 route id）、对应 handler、`bodies.ts` 的字段级校验、以及 `http.ts` 的分页与长度上限。**沙箱内没有 Flutter/Dart 工具链，因此没有运行客户端，也没有做客户端与服务端的联调**；下面每条结论都对应到具体文件与行号，凡是没跑过的检查都会明确标注。

> Flutter 客户端自己的迁移审计 `docs/supabase-to-nowave-migration.md` 独立列出了同一批待办（其中 G2 是「修改邮箱/密码」，G3 是「`/me` 里的 email 未使用」），与本表互为佐证。

## 覆盖矩阵

状态列：✅ 已覆盖并字段兼容；⚠️ 已覆盖但有语义注意事项（见 P3）；❌ 缺失。

### 身份与会话

| Flutter 调用 | 服务端路由 | 状态 |
|---|---|---|
| `POST /auth/register` | `auth` action `register` | ✅ |
| `POST /auth/login` | `auth` action `login` | ✅ |
| `POST /auth/refresh` | `auth` action `refresh` | ✅ |
| `DELETE /me/session` | `me.session` | ✅ |
| `GET /me` | `me` | ✅（G3：客户端未使用返回的 `email`，服务端已返回，不是缺口）|
| `GET /me/profile`、`PUT /me/profile` | `me.profile` | ✅ |
| 修改密码 | —— | ❌ → **P1，本轮已实现** `PUT /me/password` |
| 修改邮箱 | —— | ❌ → **P2** |

### 文章

| Flutter 调用 | 服务端路由 | 状态 |
|---|---|---|
| `GET /articles?locale&query&limit&offset` | `articles` | ✅ |
| `GET /articles/:slug` | `articles.item` (GET) | ✅ |
| `POST /articles` | `articles` (POST) | ✅ |
| `PUT /articles/:articleId` | `articles.item` (PUT) | ✅ |
| `DELETE /articles/:articleId` | `articles.item` (DELETE) | ✅ |
| `GET /me/articles/deleted` | `me.deleted-articles` | ✅ |
| `POST /articles/:id/restore` | `articles.restore` | ✅ |
| `GET /articles/:slug/related` | `articles.related` | ✅ |

字段层面：客户端 `uploadBlog` 发送 `{title, contentBlocks, contentBlocksVersion: 0, publish, locale, tagIds}`，`updateBlog` 额外必带 `slug` 与 `publish`，删除后返回墓碑；`nowave_article_codec.dart` 产出的 v0 块（`id` + `image{src}` / `paragraph{text}`，封面取第一个图片块）与 `apps/api/src/domain/article.ts` 的 v0 规则一致。分页常量 `kBlogPageSize=10`、`kMaxSearchResults=50`、`_kListLimit=100`、`_kRelatedLimit=6` 都落在 `parsePagination` 的 1–100 与 `MAX_ARTICLE_OFFSET` 之内。

### 评论、点赞、标签、作者、媒体

| Flutter 调用 | 服务端路由 | 状态 |
|---|---|---|
| `GET /articles/:slug/comments` | `articles.comments` | ✅ |
| `POST /articles/:slug/comments`（带 `Idempotency-Key`）| `articles.comments` | ✅ |
| `DELETE /comments/:id` | `comments.item` | ✅ |
| `GET /articles/:slug/like` | `articles.like` (GET) | ✅ |
| `PUT /articles/:slug/like` | `articles.like` (PUT) | ✅ |
| `GET /me/liked-articles` | `me.liked-articles` | ✅ |
| `POST /tags`、`GET /tags`、`GET /tags/:slug/articles` | `tags`、`tags.articles` | ✅ |
| `GET /authors/:userId`、`GET /authors/:userId/articles` | `authors.item`、`authors.articles` | ✅ |
| `POST`/`DELETE /users/:userId/follow` | `users.follow` | ✅（参数名是 `username`，实际按 UUID 解码，见 P5）|
| `POST /me/media`（原始字节）| `me.media` | ✅ |
| `GET /api/v1/media/:id` | `media.item` | ⚠️ P3 |

## 服务端有、客户端还没用到的能力

以下都不是缺口，只是客户端尚未消费：通知（`me/notifications*`）、会话与私信（`conversations*`）、分类（`categories*`）、标签/分类的写与删（`taxonomies`、`taxonomies.item`）、`GET /users` 与 `users/:id/followers|following`、`GET /me/articles`、`POST /me/email-verification`，以及 `auth` 的 `forgot-password` / `reset-password` / `verify-email`。

## 当前前端（apps/web、apps/web-rr）的需求覆盖

两个前端只通过 `packages/web-http` 访问 9 个接口族：`me`、`me/email-verification`、`me/media`、`me/notifications*`、`articles*`、`articles/:slug/comments`、`auth/*`。全部已实现，**没有缺口**。唯一的共同注意事项是 P3。

## 缺口清单

### P1 登录状态下修改密码 —— 已实现（本轮）

`AUTH_ACTIONS` 原本只有 register/login/refresh/logout/forgot-password/reset-password/verify-email，缺少「已登录用户改密码」。数据层其实已经就绪：`setIdentityPassword` 与 `revokeIdentitySessions` 都在 identity 端口上。本轮补的是用例、路由与两端接线：

- `PUT /api/v1/me/password`，body 恰为 `{currentPassword, newPassword}`；新密码按注册规则（≥12 字符），旧密码错误返回 `401`，body 多一个字段直接 `400`。
- **语义：改密码保留发起请求的那个会话，吊销账号的其他全部会话**，响应 `revokedSessions` 是被登出的设备数。重置密码（`auth/reset-password`）相反，吊销全部——因为它没有任何设备证明过什么。
- 限流：每账号 5 次 / 15 分钟，每来源地址 20 次 / 15 分钟。
- 新增端口方法 `findIdentityCredentials`：凭据单独取，账号记录（`findIdentityAccountByUserId`）里永远不带密码哈希。
- 前端：共享行为在 `packages/web-http/src/account.ts`（`handleAccountPasswordChangeRequest`：仅接受同源 PUT、4 KiB 有界 body、转发到 `api/v1/me/password`），两个框架各一个薄适配；「我的账户」页面新增修改密码表单，两个前端共用同一个 `AccountPanel`。这也是**邮件关闭时唯一能改密码的路径**——找回密码依赖邮件，而邮件默认关闭。

### P2 修改邮箱 —— 未实现，且缺数据层

`identity` 端口里没有 `setIdentityEmail`，SQLite 与 PostgreSQL 适配器都没有实现，需要新增端口方法 + 两个适配器 + 契约测试。策略未定：邮箱改完是否要重新验证？当前建议**暂不强制**——邮件功能未启用（`MAIL_ENABLED` 默认关闭，Brevo 尚未注册），强制重新验证等于把账号功能挂在一个打不开的流程上；等邮件真正启用时再决定。

### P3 媒体 `src` 是应用相对路径 —— 不是缺陷，是语义

上传返回的 `src` 是 `/api/media/<id>`（`apps/api/src/application/media-assets.ts`），因为两个前端各自提供 `GET /api/media/:id` 转发到 API 的 `/api/v1/media/<id>`。所以 Web 用 `src` 是对的；直接访问 API 的 Flutter 需要自己拼 `/api/v1/media/<id>`，它也正是这么做的。**建议不要改 `src`**：`apps/web/src/components/authoring/article-editor.tsx` 的正则只接受 `/api/media/<uuid>`，改动会破坏它以及已存内容。改为：文档写明语义 + 在 API 上补一个 `/api/media/:id` 别名。

### P4 孤儿媒体回收 —— 运维项

`media-assets.ts` 里写明「孤儿清理是运维后续项」：没有删除接口、资源不可变、每次上传都是新 id，于是未被引用的上传会一直累积。需要决定回收策略（例如定时扫描未被任何 `contentBlocks` 引用的资产）。

### P5 同一路径位两种寻址 —— 文档 + 兼容性

`/articles/:x` 只有一个路径位：GET 取 slug（`decodeSlug`），PUT/DELETE 取 UUID（`decodeUserId`）。`authors.*` 与 `users.follow` 声明 `param("username")` 但用 `decodeUserId` 解码（UUID 能校验通过，只是名字有误导性）。修法：文档写清楚，和/或让两个标识符都能接受。

### P6 观察项，不是缺口

- 注册/登录的按 IP 限流默认 20/小时，在运营商 NAT 后面可能误伤（e2e 已把该值调到 60）。
- 没有设备令牌接口；将来要做推送时再加。

## 下一步

1. P3：媒体 `src` 语义写进文档 + API 侧 `/api/media/:id` 别名（小改动）。
2. P2：等「改邮箱是否强制重新验证」这个决定，再动数据层。
3. P4：需要你定回收策略。
4. P5：文档与兼容性（可与 P3 合并成一个小 PR）。
