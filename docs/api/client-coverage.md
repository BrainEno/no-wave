# 客户端接口覆盖度检查

**目的**：回答两个问题——服务端 `/api/v1` 是否已经覆盖 Flutter 移动客户端
([BrainEno/flutter-blog](https://github.com/BrainEno/flutter-blog)) 的全部接口需求，以及它是否同时满足当前两个前端（Next.js `apps/web`、React Router `apps/web-rr`）的需求。

**结论（摘要）**：

- **路由级覆盖 30/30**：Flutter 客户端调用的 30 个 `client.*Json` 调用点，每一个都能在 `apps/api/src/transport/rest/routes.ts` 的路由表里找到对应项，且请求/响应字段与 `apps/api` 的序列化器一致。
- **当前前端无缺口**：两个前端通过 `packages/web-http` 只使用 9 个接口族，全部已实现。
- **真实缺口 4 项 + 2 项观察**：见下方「缺口清单」。P1（登录状态下修改密码）、P2（修改邮箱）、P3（媒体 `src` 语义 + API 侧别名）、P5（路径位寻址的命名与文档）**均已关闭**；只剩 P4（孤儿媒体回收）需要你先定策略。

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
| 修改密码 | —— | ❌ → **P1 已实现** `PUT /me/password` |
| 修改邮箱 | —— | ❌ → **P2 已实现** `PUT /me/email` |

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

### P2 修改邮箱 —— 已实现（本轮）

`identity` 端口原先没有 `setIdentityEmail`，所以这一项既有接口缺口也有数据层缺口。现在补上了：

- `PUT /api/v1/me/email`，body 恰为 `{password, email}`：**必须提供当前密码**——谁掌握了邮箱，谁就掌握了这个账号的找回途径，所以仅有会话不能搬走它。
- 新邮箱按注册规则规范化（trim + 小写），唯一；被别的账号占用 → `409`。
- **改完之后地址变成「未验证」，但不强制重新验证，也不发邮件**：验证不 gate 任何功能（未验证照样登录、写作、发布），而邮件默认关闭，强制走邮箱等于把改地址变成一件做不到的事。想验证的话，账户页原有的「发送验证邮件」按钮照旧可用。
- **不吊销任何会话**：改地址不是换凭证，已登录的设备仍然是本人的设备。
- 请求当前已在使用的邮箱 → `200` 且验证状态不变（不是一次变更，不该让它丢掉已有的证明）。
- 限流：每账号 5 次 + 每来源地址 20 次 / 小时。
- 数据层：新增端口方法 `setIdentityEmail`，SQLite 用 `UPDATE OR IGNORE`（唯一索引裁决），PostgreSQL 用 `NOT EXISTS` 守卫 + 唯一违反兜底，并发下同一地址只有一个赢家。
- 前端：`handleAccountEmailChangeRequest` 在 `packages/web-http`，两个框架各一个薄适配；账户页新增「修改邮箱」表单，成功后直接用响应里的新地址刷新显示。

### P3 媒体 `src` 是应用相对路径 —— 不是缺陷，是语义

上传返回的 `src` 是 `/api/media/<id>`（`apps/api/src/application/media-assets.ts`），因为两个前端各自提供 `GET /api/media/:id` 转发到 API 的 `/api/v1/media/<id>`。所以 Web 用 `src` 是对的；直接访问 API 的 Flutter 需要自己拼 `/api/v1/media/<id>`，它也正是这么做的。**建议不要改 `src`**：`apps/web/src/components/authoring/article-editor.tsx` 的正则只接受 `/api/media/<uuid>`，改动会破坏它以及已存内容。

**已在本轮解决**：API 现在直接应答 `GET /api/media/<id>`——它在路由解析之前被重写成 `/api/v1/media/<id>`，因此走的是同一个 handler、同一套方法限制（`405 allow: GET`）与同一套缓存头，不是第二份实现。这样直连 API 的客户端可以直接使用正文里的地址，而 `src` 的形状保持不变。语义本身写在 `apps/api/README.md` 的「Media addresses and the application-relative `src`」一节。

### P4 孤儿媒体回收 —— 运维项

`media-assets.ts` 里写明「孤儿清理是运维后续项」：没有删除接口、资源不可变、每次上传都是新 id，于是未被引用的上传会一直累积。需要决定回收策略（例如定时扫描未被任何 `contentBlocks` 引用的资产）。

### P5 同一路径位两种寻址 —— 文档 + 兼容性

`/articles/:x` 只有一个路径位：GET 取 slug（`decodeSlug`），PUT/DELETE 取文章 id（`decodeUserId`）。`authors.*` 与 `users.follow` 原先声明 `param("username")`，但那里从来不是用户名（系统里没有用户名字段），实际传的是用户 id——只是名字有误导性。

**已在本轮解决（命名 + 文档，不改行为）**：

- 路由表参数名改正：`users.follow`、`users.relationships`、`authors.item`、`authors.articles` 的 `username` → `userId`；`articles.item` 的 `slug` → `article`（这个位置承载两种标识符，`slug` 只对 GET 成立；`articles.like` / `comments` / `related` 全是 slug，名字保持 `slug`）。
- `apps/api/README.md` 新增「Path parameters: which identifier each method takes」表格，逐个路径位写明每个方法用哪种标识符。
- 顺带纠正上一轮描述里的一处不准确：`decodeUserId` **不校验 UUID 形状**，它只做路径段解码与边界检查（可解码、非空、≤300 字符、无首尾空白）——标识符是不透明字符串，形状不做校验，不认识的标识符由存储层回答 404。这一点已写进 README 与该函数自己的注释，避免后来者误以为它是一道校验。

### P6 观察项，不是缺口

- 注册/登录的按 IP 限流默认 20/小时，在运营商 NAT 后面可能误伤（e2e 已把该值调到 60）。
- 没有设备令牌接口；将来要做推送时再加。

## 下一步

只剩 **P4 孤儿媒体回收**：资产不可变、没有删除接口、每次上传都是新 id，所以没有被任何正文引用的上传会一直累积。需要你先定策略——定时扫描回收（运维脚本）还是给一个受控的删除接口——再决定实现。

P1 / P2 / P3 / P5 均已关闭，无需再排。
