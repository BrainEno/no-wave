# no-wave / BOT THK 代码库全面 Review

- 审阅日期：2026-11-02
- 审阅基线：`arena/c5760b16-no-wave`，HEAD `0050da1`（Merge PR #153）。本地为浅克隆，只有这一个提交可见。
- 对应上游：`BrainEno/no-wave`。GitHub 上当前 **21 个 open issues、0 个 open PR**；部分 issue 正文写的快照是 `6863b4a` 或更早 commit，和本 checkout 不完全一致，本报告的所有结论都以 `0050da1` 的源码重新核对过。
- 本报告只做审阅，不改功能代码；新增的仅是本报告文件。

---

## 0. 一句话结论

这是一个**功能覆盖相当广、分层意识很强、测试与文档量远超一般原型**的 TypeScript monorepo：API、Web、共享 BFF/UI、CI、双数据库迁移、Outbox、可观测性、E2E 都已成形。但它**还不是生产就绪状态**：已有若干会在真实使用/部署中直接触发的正确性、数据一致性、CI 和 UI 缺陷；性能放大器、文档漂移、测试清单静默漏跑、以及审核/实时/PWA 等能力缺口也还没有收口。

最该先动的 5 个修复（4 个 P0 + 1 个紧邻的 P1）：写作台链接正则、带幂等键文章在自动 slug 冲突后无法重放、媒体删除的并发数据丢失风险与缺少服务端开关、`.gitlab-ci.yml` 三重失效、Web 生产服务器畸形 URL 直接 500。

---

## 1. 代码规模

统计口径：`git ls-files` 的 452 个受版本控制文件；代码类文件按 `.ts/.tsx/.sql/.css/.py` 统计物理行，注释/空行另列。`pnpm-lock.yaml`、JSON/YAML、Markdown 单独统计。

| 维度 | 数量 | 物理行 | 备注 |
|---|---:|---:|---|
| 全部 tracked 文件 | 452 | — | 仓库体积约 7.4 MB（不含 `.git`） |
| `.ts` | 251 | 44,974 | |
| `.tsx` | 57 | 7,326 | |
| `.sql` | 37 | 842 | PostgreSQL 22 个迁移 + SQLite 14 个迁移 + 1 个其他 |
| `.css` | 2 | 1,230 | 其中 `home-page.module.css` 777 行是已不可达的旧样式 |
| `.md` | 69 | 7,700 | `docs/` 63 篇 + README/AGENTS 等 |
| JSON / YAML / YML | 18 | 3,751 | 含 `pnpm-lock.yaml` 约 2.7k 行 |
| 代码类文件合计 | 348 | **54,420** | 其中约 43,420 行非空非注释「代码行」 |
| ├─ 生产源码 | 257 | **32,503** | 约 25.5k 代码行（含构建/脚本/配置文件） |
| └─ 测试 / mock / E2E | 91 | **21,917** | 约 17.9k 代码行；80 个 `*.test.ts`、6 个 Playwright spec、3 个 E2E support、1 个 REST mock、1 个 web-http test helper |

按工作区分组：

| 区域 | 文件 | 行数 | 主要职责 |
|---|---:|---:|---|
| `apps/api` | 159 | 29,021 | REST API、领域/应用/持久化/安全、迁移、Outbox worker |
| `packages/web-ui` | 79 | 11,471 | 共享 React 组件、Lexical 状态、公共页 loader、文案与工具 |
| `apps/web-rr` | 62 | 5,010 | React Router 7 Framework Mode SSR 应用、资源路由、生产 `server.ts` |
| `packages/web-http` | 27 | 4,503 | 框架无关的浏览器代理/BFF 行为（cookie、origin、转发、body 限额） |
| `scripts` | 10 | 2,903 | 本地 dev、连通性探测、portable stack、route smoke |
| `e2e` | 9 | 1,413 | 6 个 spec，约 27 个 Playwright 用例 |
| `docs` | 63 | 6,734 | ADR、roadmap、审计、运维、测试策略 |
| 根目录文件 | 17 | 3,587 | README、AGENTS、`.gitlab-ci.yml`、compose、vercel、env 示例等；不含 `.github/workflows/ci.yml`（444 行） |

本表口径是「各应用/包里的 TS/TSX/SQL/CSS/PY + `docs/` 的 Markdown + 根目录文件」，故意不含包内 README/manifest/Dockerfile、静态图片与 `.github/workflows/ci.yml`，所以合计 426 个文件而非 452。若对全部 tracked 文件直接跑 `wc -l`，结果是 **452 个文件 / 80,585 行**，其中 JPG/ICO/PNG 里的换行字节只是规模噪声，不应与源码行数混为一谈；工程规模仍以上面的「代码类文件 54,420 行」为准。

接口规模：

- REST 路由表 `apps/api/src/transport/rest/routes.ts`：**49 个 route id / 63 个 method 级操作**（GET 32、POST 12、PUT 9、PATCH 1、DELETE 9）。`auth` 一个 route id 承载 7 个 action（`register/login/refresh/logout/forgot-password/reset-password/verify-email`），所以按具体 URL 计约 55 个。
- Web `apps/web-rr/app/routes.ts`：**49 条路由声明**（1 个 index + 48 个 route，共用 41 个路由模块），其中 **22 条是同源 `/api/*` 资源路由**，27 条是页面/SEO 路由。
- 迁移：PostgreSQL 22 个、SQLite 14 个；两套编号不同，靠契约测试与人工同步保持语义一致。
- 测试：根 `pnpm test` 列出 74 个测试文件；`pnpm test:web` 另跑 3 个；6 个 Playwright spec 由 `pnpm test:e2e` 跑。

---

## 2. 设计思路

### 2.1 总体架构

pnpm workspace：两个可部署应用（`apps/api`、`apps/web-rr`）加两个共享包，另有可独立启动的 Outbox worker/drain：

```
apps/web-rr (React Router 7 SSR)
    ├── packages/web-ui       共享 React 组件 / 公共页 loader / 文案
    └── packages/web-http     框架中立 BFF：cookie、Origin、token refresh、转发
                │
                └── apps/api (/api/v1 REST，Node http，无框架)
                         ├── transport/rest   路由表、分派、body、序列化、限流
                         ├── application     服务门面、身份、邮件、媒体、限流
                         ├── domain          校验、slug、内容契约、cursor、错误
                         ├── security        JWT、密码、授权
                         ├── infrastructure  运行时/迁移检查、S3、SMTP、可观测性
                         └── persistence     SQLite / PostgreSQL 适配器 + 迁移
                                  └── outbox + notification worker/drain
```

要点：

1. **REST-only 业务 API**：GraphQL/Yoga 已完全移除；`/api/v1` 是唯一业务 HTTP 传输。未知 GET 路径统一 JSON 404；未知写路径按旧兼容返回 `405 allow: GET`（见 F-26）。
2. **单一路由事实源**：`REST_ROUTES` 同时决定路径匹配、允许方法与 `405 Allow`；`handler.ts` 只做前缀检查、重复 query 拒绝、媒体别名重写与上下文组装；`REST_ROUTE_GROUPS` 按域分派（auth → 通用写限流 → media/health/identity/notification/conversation/article/author/taxonomy）。
3. **Clean-ish 分层 + 端口/适配器**：`persistencePortMethods` 是运行时 `assertPersistenceAdapter` 与编译期类型的单一来源；SQLite 拆成 10 个 `sqlite-*-store.ts`，PostgreSQL 集中在一个 `postgres.ts`。业务事实先落库，再经事务性 outbox 投递通知。
4. **SQLite-first，PostgreSQL 生产推荐**：启动时检查 schema 版本，pending migration 直接拒绝启动；`node:sqlite` 在 Node 24.15+ 仍是 Release Candidate，生产建议 PostgreSQL。MongoDB 明确是未来适配器，切换 provider 不等于数据迁移。
5. **身份与浏览器边界分离**：API 发 JSON access/refresh token；Web 通过 HttpOnly cookie + 同源资源路由代理，access cookie 限 `/api/authoring`、refresh 限 `/api`，写请求强制 Origin 精确匹配，401 后由 BFF 做一次 refresh-retry。
6. **内容契约自有而非 Lexical 原文**：服务端持久化 versioned `contentBlocks`；Lexical `editorState` 是 write-only ingress，严格适配器拒绝不能无损表达的 node/URL/mark；评论使用更小的富文本子集。
7. **SSR + 缓存分层**：公共页 `public, max-age=0, s-maxage=60, stale-while-revalidate=300`；私有/查询页 `no-store`；硬 404 而不是 soft 404；`meta` 的站点 origin 由 root loader 在请求时读取，避免构建期冻结。
8. **可观测/运维**：结构化 JSON 日志、`X-Request-Id`、`/metrics`（默认关闭）、Outbox backlog 指标、优雅关闭、`/healthz`、容器镜像、portable stack 10 步探测。

### 2.2 已经做得好的地方（重构时不要破坏）

- JWT：HS256 + `timingSafeEqual`，校验 typ/iss/aud/iat/exp/nbf/jti，拒绝 `crit`/`b64:false`；身份只从 `Authorization` 解析。
- 密码：scrypt，未知用户同样付 KDF 代价；改密/改邮箱要求当前密码；刷新令牌轮换 + 重用检测 → 吊销整个 token family。
- 资源级授权在持久化层重复校验，不依赖传输层；私有会话、收件箱、草稿隔离都有契约测试。
- 幂等：`Idempotency-Key` 只存摘要，作用域绑定 verified actor + method/route，指纹与业务行同事务提交，冲突返回 409。
- 限流：按用户 + TCP peer IP 双桶，HMAC 派生 key，不信任 `X-Forwarded-For`；`rate-limit.test.ts` 会遍历 `REST_ROUTES` 断言每个写路由必须有策略或显式豁免。
- 媒体上传：sharp 强制重编码 WebP、限制像素/尺寸、读取时校验 sha256 与字节数、不可变 ETag + `nosniff` + CSP sandbox。
- 错误与日志：出站错误统一 sanitize；未映射异常只记 `errorName`/截断 `errorMessage`，不记 URL/query/头；`safeLogPath` 只留 path。
- 既有审计 `docs/audit/backend-review-2026-11.md` 的 A1（图片 body 正则）、A2（5 个漏限流写端点）、A3（SQLite 私信通知 drain）**已在本快照中修复并验证**：`http.ts:409/413` 已改回 `/^\d+$/`，`rate-limit.ts` 补齐策略与覆盖测试，`notification-worker.ts`/`notification-drain.ts` 已走 `createPersistenceRuntime`。

### 2.3 API 清单（按域）

| 域 | 主要端点 |
|---|---|
| 系统 | `GET /health`、`/ready`、`/metrics`；`GET /api/v1/health`；`GET /api/media/:id`（重写为 `/api/v1/media/:id` 的别名） |
| 认证/账号 | `POST /auth/{register,login,refresh,logout,forgot-password,reset-password,verify-email}`；`GET /me`；`GET/PUT /me/profile`；`PUT /me/password`、`PUT /me/email`；`POST /me/email-verification`；`DELETE /me/session`；`GET/DELETE /me/sessions`、`DELETE /me/sessions/:id` |
| 作品 | `GET/POST /articles`；`GET/PUT/DELETE /articles/:article`（GET 用 slug，PUT/DELETE 用 id）；`POST /articles/:id/restore`；`GET /me/articles`、`/me/articles/deleted`、`/me/liked-articles`、`/me/feed`；`GET /articles/:slug/related`；`GET/PUT /featured`；`GET/PUT /articles/:slug/like` |
| 评论 | `GET/POST /articles/:slug/comments`；`DELETE /comments/:id` |
| 分类/标签 | `GET/POST /tags`；`GET /tags/:slug`、`/tags/:slug/articles`；`POST /taxonomies`、`DELETE /taxonomies/:id`；`GET /categories`、`/categories/:slug`、`/categories/:slug/articles` |
| 作者/关系 | `GET /users`；`POST/DELETE /users/:userId/follow`；`GET /users/:userId/{followers,following}`；`PUT /users/:userId/role`；`GET /authors`、`/authors/:userId`、`/authors/:userId/articles` |
| 媒体 | `GET/POST /me/media`；`DELETE /me/media/:id`；`GET /media/:id` |
| 私信/会话 | `GET/POST /conversations`；`GET/DELETE /conversations/:id`；`GET/POST /conversations/:id/messages`；`PATCH /conversations/:id/participants`；`PUT /conversations/:id/read` |
| 通知 | `GET /me/notifications`、`/me/notifications/unread-count`；`POST /me/notifications/read-all`；`PUT /me/notifications/:id/read` |
| Web 同源 BFF | `api/auth/:action`、`api/authoring/{session,sessions,password,email,email-verification,articles,deleted-articles,featured,featured/candidates,media,notifications*}`、`api/articles/:slug/comments`、`api/media/:id`、`api/spike/events` |

契约要点：`Idempotency-Key` 1–300 trimmed 字符；会话/消息创建必带，文章/评论创建可选；`429` 带 `Retry-After`；`locale` 支持 `zh-CN/zh-TW/en`；文章列表支持 `offset` 与 `cursor` 互斥、`sort=latest|popular`、`limit<=100`；`contentBlocks` 是 JSON 数组；错误体 `{error:{code,message}}`。

---

## 3. 多维度评分

| 维度 | 评价 | 理由 |
|---|---|---|
| 架构合理性 | **4 / 5** | 分层、端口契约、路由单一事实源、BFF 边界、Outbox、双 provider 都很清晰。扣分在 `postgres.ts` 2,241 行巨石、端口仍是 `any`、两套迁移需人工同步、限流策略仍是第二份手写路径清单。 |
| 健壮性 / 正确性 | **3 / 5** | 事务、授权、幂等、限流、迁移检查做得很细；但幂等指纹、游标精度、媒体删除并发、Web 静态服务异常路径仍有已确认缺陷，且 SSR `fetch` 没有超时。 |
| 安全基本面 | **4 / 5** | 自托管身份实现质量高；剩余是显式取舍/运维边界：注册邮箱枚举、`EDITOR_USER_IDS` 引导后门、反代后 IP 桶退化、metrics 无鉴权、启动日志可能回显畸形 DSN、邮件默认关闭、验证不门禁功能。 |
| UI / UX | **2.5 / 5** | 有完整设计系统文档与多语言、SSR、阅读工具；但通知铃铛还是占位、写作台大量原生 `prompt/alert/confirm`、链接插入 100% 失效、英文路由硬编码中文、WebGL 回退会破坏 React DOM、平滑滚动吞点击、全站噪点画布持续烧 CPU。 |
| 性能 / 扩展性 | **2.5 / 5** | 有边界（分页上限、body 限额、扫描上限），但文章列表 `1+3N` 查询、媒体库全表拉正文、GrainCanvas 主线程逐像素、SQLite 同步阻塞均无实测基线；默认 SQLite 单写者容量未知。 |
| 测试 / CI | **3 / 5** | 720 个根测试用例（本环境 629 pass / 1 fail / 90 skip，详见第 6 节）+ 65 个 Web 行为测试 + Playwright；GitHub Actions 8 个 job + required-checks 很完整。但根测试脚本是硬编码清单且有一个不存在的路径，导致 4 个测试文件静默不跑；GitLab CI 的容器冒烟确定失效、verify 阶段在 Alpine 下高风险（F-04）；E2E 用 `reducedMotion: reduce` 绕开了一个真实点击 bug。 |
| 文档一致性 | **2 / 5** | 69 个 Markdown 文件（其中 `docs/` 63 篇）非常详尽，但大量状态没有随代码更新：README、AGENTS、feature-traceability、platform-capability-backlog、api-authentication、API README、UI 设计系统、phase-gates 互相矛盾；ADR 0011 编号重复。 |
| 运维/产品成熟度 | **2.5 / 5** | 容器、健康检查、优雅关闭、指标、迁移检查都有；但无生产部署/主机资格验证、无性能基线、无 OpenAPI、无审核/举报、无实时/推送、无 PWA、无账号注销、邮件默认关闭。 |

---

## 4. 已验证的问题 / Bug 清单

优先级：**P0** = 直接破坏核心流程或数据；**P1** = 高概率用户可见 / 性能与一致性风险；**P2** = 工程债、可维护性、体验缺口；**P3** = 记录/清理项。

> 说明：GitHub issue #154–#168 的正文基于 `6863b4a` 等快照。下面每条都在当前 `0050da1` 重新核对；个别 issue 的细节已经过时，会显式标出。

### 4.1 P0

| ID | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|
| F-01 | 写作台插入链接正则双重转义，所有 `http(s)://` 和站内绝对路径被拒绝 | `packages/web-ui/src/components/authoring/article-editor.tsx:80` 是 `/[\\u0000-\\u0020\\u007f\\\\]/`；正确写法见 `article-comments.tsx:44`。Node 实测 `https://example.com`、`http://nowave.org/a`、`/articles/2026` 的 `bad.test()` 均为 `true` | 对应 #154。所有合法链接 100% 被弹窗拒绝。改成 `/[\u0000-\u0020\u007f\\]/`，提取为共享 `sanitizeEditorHref()` 并补单测 |
| F-02 | 自动 slug 冲突后，带 `Idempotency-Key` 重放 `POST /api/v1/articles` 返回 409 | `routes/articles.ts:33-38` 每次从 `attempt=1` 重新生成候选 slug 并把它传进 `createArticle`；指纹把候选 `input.slug` 算进去：`sqlite-article-store.ts:369-374`、`postgres.ts:1325-1330` | 对应 #137 / #157。首次在 `title-2` 落库，重放用 `title` 算指纹 → `IDEMPOTENCY_CONFLICT`。应把「客户端显式 requestedSlug」与「服务端候选 slug」分开，双适配器 + REST 回归覆盖顺序/并发重放 |
| F-03 | 媒体删除可能造成已发布作品/头像图片永久 404；且没有服务端开关 | `DELETE /me/media/:id` 存在于 `routes/media.ts:132-182`，服务端没有对应开关（只有 `media-library.tsx:67` 的客户端 `DELETE_ENABLED = false`）；`postgres.ts:2189-2235` 在默认 READ COMMITTED 事务里 `SELECT ... ILIKE` 后 `DELETE FROM media_assets`，写入侧不锁该行；`media-assets.ts:473-493` 先删库行再删远端对象 | 对应 #146 / #156。并发保存文章/头像与删除之间仍有 write skew；直接调 API 的 Flutter 客户端不受前端按钮隐藏保护。**本快照已部分改进**：`MEDIA_SRC_PATTERN` 现匹配 `/media/<uuid>`（覆盖 `/api/media`、`/api/v1/media`、绝对 URL）且扫描头像，`media.ts:155` 已有 `media.object_orphaned` 结构化告警——所以 #146 的「漏检版本化路径/头像」和 #156 的「没有告警日志」两项描述已过时。仍需：默认关闭的服务端开关 + 物化引用表/锁协议 + 双库并发与对象存储失败回归 |
| F-04 | GitLab CI 三重失效 | `.gitlab-ci.yml:9,57` 用 `node:24-alpine`（musl），而 `pnpm-lock.yaml` 只有 glibc 版 esbuild；`apps/web-rr/Dockerfile:57,84` 是 `PORT=3100/EXPOSE 3100`，CI `:37,:40,:49,:50` 却探测 `3000`；`:40` 仍断言 `lang="zh-TW"` 与「可移植的 Web 基礎架構」，当前 `root.tsx:105` 是 `zh-CN` | 对应 #155。`verify` 在 Alpine/musl 下与 lockfile 中只有 glibc 版 esbuild 的组合有很高构建失败风险（本次未在 Alpine 实跑；API 镜像同用 Alpine，但 lockfile 已含 sharp 的 musl 变体且不需要 esbuild，风险不同）；`container-smoke` 的端口 3000→3100 错配与旧繁体文案断言则是确定失配。换 `node:24-slim`、端口对齐 3100、探针改 `/healthz` + 当前 zh-CN 外壳；最好把容器冒烟逻辑抽成 GitHub Actions 与 GitLab 共用脚本 |

### 4.2 P1

| ID | 问题 | 证据 | 影响 / 建议 |
|---|---|---|---|
| F-05 | Web 生产服务器畸形百分号 URL 直接 500 | `apps/web-rr/server.ts:52` 的 `decodeURIComponent` 在 try 之外；本机实测 `GET /%E0%A4%A.js` → `500 Internal Server Error`，日志 `status:500` | 对应 #159。扫描器/坏链会污染错误监控。同文件 `:74` 的 `createReadStream().pipe(response)` 无 `error`/`pipeline`，磁盘错误或客户端断连可能击穿进程；`:33` MIME 白名单含 `.map`（当前构建未产出 `.map`，属潜在暴露）。用 try/catch 回 400、`pipeline()`、移除 `.map` |
| F-06 | PostgreSQL 游标微秒截断导致跨页漏数据 | 文章列表 `postgres.ts:1160-1161` 用未截断的 `published_at` 与 JS `toISOString()` 毫秒游标比较；媒体库 `postgres.ts:2170,2176` 同样；`media-assets.ts:452` 生成 `nextCursor` | 对应 #133 / #158。`GET /articles`、`/authors/:userId/articles`、`/me/media` 在同一毫秒多条记录时可能跳过。统一写入侧 `date_trunc('milliseconds')` 或让游标携带原始精度；补真实 PostgreSQL 跨页回归 |
| F-07 | 文章列表序列化 N+1 | `serializers.ts:23-33` 每篇文章 3 次查询（作者档案 + 分类 + 标签），`:44-50` 并发但不减少总量；`getAuthorProfile` 自身还带多个相关子查询 | 对应 #162 / 审计 B1。按代码路径推算 `limit=100` 约 301 条 SQL（既有审计 B1 已有实测计数，本次未重跑），SQLite `DatabaseSync` 全部同步阻塞主线程。增加批量作者/分类/标签端口，或列表用精简卡片投影 |
| F-08 | 媒体库每次拉全站所有译文正文 | `media-assets.ts:443` 调 `store.listMediaScanRows()`；`postgres.ts:2138-2146` 与 `sqlite-media-store.ts` 返回所有文章所有语言 `content_blocks` | 对应 #163 / 审计 B2。按每篇约 4 KiB 正文静态估算，2,000 篇约 7.7 MiB/次、2 万篇约 77 MiB（既有审计 B2 已实测，本次未重跑），且 `listMediaScanRows` 同步阻塞主线程；`GET /me/media` 与 `DELETE` 各一次。物化 `article_media_refs`，与文章保存同事务维护，也能顺带解决 F-03 的协调问题 |
| F-09 | 首页 WebGL `HeroCanvas` 7 次原生 `canvas.remove()` 摘除 React 托管节点 | `packages/web-ui/src/components/motion/hero-canvas.tsx:49,57,64,82,126,169,186`；组件返回 `<canvas ref={ref} />` | 对应 #160。无 WebGL/着色器失败/封面失败时 DOM 被外部移除，React 卸载时 `removeChild` 可抛 `NotFoundError`。改用 state 触发 `return null`；同时非 reduced-motion 下的 rAF 循环即使 `visible=false`/`ready=false` 也持续调度空转回调（`:160-163,198`），应停帧 |
| F-10 | 全站通知铃铛是占位：`unread = 0`，登录用户也被叫去登录 | `site-chrome.tsx:105` `const unread = 0`；`:238-240` 面板固定「暂无通知 + 去登录」；后端 `/me/notifications*` 与 Web BFF 都已实现 | 对应 #161。首页/阅读页/账户页看不到真实未读，点开反而被要求登录。水合后按非敏感 session marker 拉 `unread-count`/列表，401 才显示登录引导 |
| F-11 | 平滑滚动吞点击 + 全站噪点画布持续烧 CPU | `site-chrome.tsx:111` 无差别创建 `ScrollSmoother({smooth:1.2})`；`:47-58` 每 125ms 对半分辨率全屏逐像素 `Math.random()` + `putImageData`；`playwright.config.ts:44` 全局 `reducedMotion:"reduce"` | 对应 #92 / #164。2K 屏约 92 万像素 × 8fps ≈ 737 万次随机数/秒；写作/表单页滚动动画中 mousedown/mouseup 落在不同元素会静默丢点击，E2E 通过关闭动效绕开。应在工具页停用 smoother、噪点改预生成纹理/降频/OffscreenCanvas，并补真实动效下的点击断言 |
| F-12 | 写作台与产品/契约/设计系统脱节 | `article-editor.tsx:77,81,89,106,112,310,375`、`media-library.tsx:232`、`article-comments.tsx:124` 仍用 **9 处**原生 `prompt/alert/confirm`；`:203` 仍列已决定不做的「连载」（`UI_DESIGN_SYSTEM.md:274,282` 也还写着 Serial；`api-content.ts:39` 仍把 `serial` 算合法类型）；`:272` 写死 `locale:"zh-CN"`；保存不生成 `Idempotency-Key`（`web-http/src/policy.ts:21` 已支持透传，`rest-idempotency.md:118-120` 明确说 desk 尚未 mint）；`ui-copy.ts:71,147` 登录页文案仍写「身份验证尚未实现 / Authentication is not implemented」；`site-chrome.tsx:247` 英文路由菜单仍硬编码「写作」；阅读页缺收藏/关注/关注流/私信入口 | 对应 #168。移动端 WebView 的 `prompt()` 可能直接返回 `null`；弱网重复发文无重放保护；英文作品无法创作；登录文案与已可用 `/api/auth/*` 相反；产品决策未落到 UI。改为内联浮层表单、去掉 `serial`、开放 `zh-CN/en`、按用户意图生成 UUID key、修正文案、分批接社区能力 |
| F-13 | 测试清单静默漏跑 4 个测试文件 | `package.json:27` 根 `test` 脚本引用不存在的 `scripts/local-dev-config.test.ts`（真实文件在 `scripts/lib/`）；在本沙箱 Node 22 的多文件模式下，`node --test` **静默忽略**了这个不存在的路径（项目目标 Node 24 需复核，但该文件无论如何不会被执行）。另有 `packages/web-ui/src/lib/{covers,reading,work-types}.test.ts` 不在任何脚本里 | 本机实测：这 4 个文件的用例名均未出现在根 `pnpm test` 与 `pnpm test:web` 输出中。新增测试也容易忘记加进硬编码清单。改成 `node --test <glob>` 或显式按目录发现，并加一条 CI 断言「所有 `*.test.ts` 都被执行」 |

### 4.3 P2 / P3

| ID | 问题 | 证据 | 建议 |
|---|---|---|---|
| F-14 | 文档与实现互相矛盾，会误导维护者 | 见 4.4；另 `apps/api/src/application/services.ts:30-32` 注释仍把调用方称作 GraphQL resolvers | 见 4.4。把「状态型」文档改成从路由表/测试清单生成，或在 CI 加一致性断言 |
| F-15 | `postgres.ts` 2,241 行巨石；持久化端口仍是 `any` | `apps/api/src/persistence/postgres.ts`、`persistence-ports.ts:76,90`、`services.ts:20-28` | 对应 #167。按 SQLite 的 10 个域切片拆分，定义显式输入/输出接口，去掉 `(...args:any[])=>any` |
| F-16 | 10 个不可达旧 UI 文件（约 2,005 行）+ 生产仍挂 spike 路由 | 从 `apps/web-rr/app` 入口做传递性可达性分析，零引用清单为 `home-page.module.css`(777)、`home/home-experience.tsx`(489)、`home/hero-gl-canvas.tsx`(184)、`home/home-copy.ts`(157)、`home/home-nav.tsx`(147)、`home/loading-screen.tsx`(111)、`content-pages.tsx`(55)、`home/grain-canvas.tsx`(52)、`search-page.tsx`(17)、`home-page.tsx`(16)，它们只互相引用；`apps/web-rr/app/routes.ts:44,70` 仍暴露 `/spike-form`（且 `spike-form.tsx:27` 用 `PUBLIC_PAGE_HEADERS` 可被 CDN 缓存）与 `/api/spike/events` | 对应 #165/#166（两条 issue 完全重复）。删除死代码、下线评估期路由，避免维护者改错 `home/hero-gl-canvas.tsx` 而非实际运行的 `motion/hero-canvas.tsx` |
| F-17 | SSR/BFF 上游 `fetch` 没有超时/熔断 | `api-content.ts:207-215`、`web-http/src/forward.ts:31-36,103-108` 均无 `AbortSignal.timeout` | API 挂起会拖死 SSR 请求；公共页虽有 `s-maxage`，源站冷启动仍可能长时间占用连接。加统一超时与可配置预算 |
| F-18 | 并非所有私有页显式 `no-store` | `apps/web-rr/app/routes/sign-in.tsx` 没有 `headers`；`forgot/reset/verify-email`、`/write`、`/account`、`/search` 都有 | 给 `/sign-in`（含 `next` query 与 `mailEnabled` loader 数据）补 `PRIVATE_PAGE_HEADERS`，并加一条缓存头覆盖测试 |
| F-19 | 契约与容量工程缺口 | 全仓库无 OpenAPI/quickstart；无 benchmark/load-test/k6/autocannon；媒体上传与标签/分类创建的幂等仍标为 deferred（`rest-idempotency.md:79-81`）；`docs/api/platform-capability-backlog.md:139-143` 与 issue #64 | 产出机器可读契约与「注册→登录→发布→阅读」快速开始；建立读/认证写/消息三条路径 p50/p95/p99，特别压测 SQLite 单写者 + outbox worker；补齐剩余 create 的幂等或明确记录取舍 |
| F-20 | 产品能力仍缺 | `docs/roadmap/phase-gates.md` 大量未勾选项；`docs/api/platform-capability-backlog.md`：定时发布、版本历史、阅读数、服务端自动保存、评论编辑/点赞、举报审核、浏览器实时投递、移动推送、PWA、账号注销 | 对应 #72 等。先写 ADR 再做审核/角色模型；实时与推送是传输层，不应改变「持久化状态才是事实源」 |
| F-21 | 安全/运维显式取舍未收口 | 注册重复邮箱返回 409（`identity.ts` 注释承认是体验取舍）；`EDITOR_USER_IDS` 冷启动后门（`apps/api/README.md`）；`refresh` 只按 IP 限流；反代后 `request.socket.remoteAddress` 退化为共享大桶；`/metrics` 开启后无鉴权；启动失败日志会带 `error.message`，畸形 DSN 可能回显；`MAIL_ENABLED` 默认 false；`node:sqlite` 即使在 Node 24.15+ 也仍是 Release Candidate（更早的 24.x 还是 Experimental） | 对应审计 D1–D4。建议：ADR 留痕注册枚举策略、生产确认 `EDITOR_USER_IDS` 为空、增加 refresh token 桶、提供受信任代理跳数配置、metrics 绑内网、日志加 DSN 脱敏、部署文档钉死 SQLite 边界 |
| F-22 | 静默失败路径缺指标；清理任务搭便车在写请求上 | `services.ts` 的 `notifyCommentAuthors` / `sweepTombstones` 吞异常；`rate-limit.ts:136-140` 每 128 次限流操作才 prune；`services.ts:45-46` 每 32 次文章写才 sweep | 对应审计 C2/C4。低流量实例的过期 session / rate-limit 状态 / tombstone 会长期不清；Outbox 也只有在单独启动 worker/drain 时才投递。补失败计数器、定时触发/运维手册，并明确 worker 是部署必选项 |
| F-23 | 通知写入串行逐条；搜索与深翻页 | `services.ts` 删除作品时对最多 200 个评论者逐个 `await createNotification`；`postgres.ts:1171-1175` 对正文 `jsonb_array_elements + ILIKE`，trigram 索引覆盖不到；`offset` 上限 10 万 | 对应审计 B3/B4。批量插入通知；搜索走全文索引或限制；对 `sort!=latest` 或大 offset 引导 cursor |
| F-24 | GitHub issue 卫生 | 21 个 open issue 中 #165/#166 完全重复，#137/#157、#133/#158、#146/#156、#92/#164、#154/#168 高度重叠；部分 issue 引用了本浅克隆中不可见的 `6863b4a` | 合并/关闭重复项，把「已在 `0050da1` 修复」的部分标清，避免把过时描述当当前缺陷 |
| F-25 | 配置/文档/构建杂项 | `README.md:82-89` 只保证 `stack:check` 不依赖平台 binding，但 `vercel.json` 仍保留 Vercel service binding 与 notification daemon，作为另一套部署入口继续存在；`web-http/src/api.ts` 注释仍说 Next.js；`react-router.config.ts` 注释仍说「别放进 Next 的 .next」；ADR `0011` 编号重复（25 个文件、24 个编号）；`pnpm dev` Web 用 3000，直接 `react-router dev`/容器用 3100；构建时有 React Router v8 future flag 与 sourcemap 定位警告 | 统一端口说明、清理历史注释、ADR 重新编号、明确 Vercel 配置是否仍受支持；future flag 可提前评估 |
| F-26 | API 行为细节 | `routes.ts:186-190` 对未知非 GET 路径返回 `405 allow: GET`；`rate-limit.ts` 的 `endpointFor` 是按路径正则手写的第二份清单，`DEFAULT_POLICY` 会掩盖拼错的 policy 名 | 前者是刻意的旧兼容，建议文档化/改为 404；后者可直接按 `routeId` 取策略，从根上消除双清单 |

### 4.4 文档漂移的具体冲突（F-14）

| 文档 | 写的 | 实际代码 |
|---|---|---|
| `README.md:19-20` | 「Email verification and account recovery remain pending / remain open」 | `identity.ts`、`identity-mailer.ts`、`smtp-client.ts` 与 `docs/operations/mail-setup.md` 都已实现，只是 `MAIL_ENABLED` 默认关闭 |
| `AGENTS.md:48` | 「The web framework is not selected until the documented framework spike is evaluated」 | ADR 0012/0017 已选定 React Router 7 并删除 Next.js |
| `docs/audit/feature-traceability.md:7-24` | 公共页仍「Web fixture only / API-backed Web pending」 | `public-pages.ts` + `api-content.ts` 已 API-backed，fixture 只在未配置 API 时使用 |
| `docs/api/platform-capability-backlog.md:118-120,142,144` | 媒体库列表 ❌、删除端点 ❌、幂等存储 ❌（仅文章创建）、API 驱动 sitemap ❌ | `GET/DELETE /me/media` 已存在；文章/评论/会话/消息创建都有幂等摘要，见 `rest-idempotency.md`；`apps/web-rr/app/routes/sitemap.xml.ts` 已走 `loadSitemapEntries` |
| `apps/api/README.md:244-245` | 「editor only accepts `/api/media/<uuid>`」「there is no delete or replace endpoint」 | `MEDIA_SRC_PATTERN` 已匹配任意 `/media/<uuid>`（含 `/api/v1/media` 与绝对 URL）；路由表有 `me.media.item DELETE`，`media.ts:132-182` 已实现 |
| `docs/architecture/api-authentication.md:109` | 「No provider adapter exists … recovery is not production-usable until one is added」 | 已实现通用 SMTP submission relay（`smtp-client.ts` + README 的 `MAIL_SMTP_*` 表） |
| `packages/web-ui/docs/UI_DESIGN_SYSTEM.md:274,282,351` | 仍把「连载 Serial」列为作品类型 | issue #168 引用的产品决策（`38d087b`）已明确「专注中短篇，不做长篇连载」；但 `article-editor.tsx:203`、`api-content.ts:39` 仍保留 `serial` |
| `docs/roadmap/phase-gates.md` | 多处 GraphQL/Next.js 相关 checkbox 仍未勾 | GraphQL 与 Next.js 已从代码树移除 |

---

## 5. 建议的修复顺序

1. **P0（本迭代）**：F-01 链接正则 → F-02 幂等指纹 → F-03 媒体删除开关与并发协议 → F-04 GitLab CI。每个都配回归测试，尤其 F-02/F-03 要 SQLite + PostgreSQL 双跑。
2. **P1（紧随其后）**：F-05 Web 静态服务异常路径、F-06 游标精度、F-07 批量序列化、F-08 媒体引用物化（可与 F-03 合并设计）、F-09 HeroCanvas 回退、F-10 通知铃铛、F-11 动效/噪点、F-12 写作台与社区 UI、F-13 测试发现机制。
3. **P2（工程债）**：F-14 文档大扫除、F-15 拆分 `postgres.ts` 与去 `any`、F-16 死代码/spike 路由、F-17 上游超时、F-18 缓存头覆盖、F-19 OpenAPI/性能基线、F-21/F-22 运维硬化、F-23 批量通知与搜索。
4. **P3（产品决策后）**：F-20 审核/实时/推送/PWA/账号注销；F-24 issue 去重；F-25 配置统一；F-26 API 细节。

原则：**先关掉会丢数据、会让用户操作静默失败、会让 CI 说谎的路径，再做性能与重构**。`article_media_refs` 物化表同时服务 F-03/F-08，适合作为一个有 ADR 的独立切片。

---

## 6. 本次实际执行的验证

| 检查 | 结果 |
|---|---|
| `corepack pnpm install --frozen-lockfile --config.engine-strict=false` | 成功（沙箱 Node 22.22.3，项目要求 `>=24 <25`，故需绕过 engine strict） |
| 根 `pnpm test`（以 `corepack pnpm --config.engine-strict=false test` 运行） | **720 tests / 629 pass / 1 fail / 90 skipped**；90 个 skip 全部是 `TEST_DATABASE_URL` 未设置的 PostgreSQL 集成用例 |
| 唯一 fail | `apps/api/src/persistence/sqlite.test.ts:61`「SQLite binding and row types…」，报错 `Provided value cannot be bound to SQLite parameter 1` / `ERR_INVALID_ARG_TYPE`，出现在沙箱 Node 22 的 `node:sqlite` 绑定 boolean 时。仓库要求 Node 24，**高度疑似沙箱运行时差异**，但本项目未在 Node 24/CI 复核，不能据此断言该用例在目标运行时一定通过 |
| `pnpm typecheck` | 根命令因 `.npmrc` 的 `engine-strict=true` + 嵌套 `pnpm` 在 Node 22 下被拒；改为逐包手工执行相同的 6 条 `tsc`/`react-router typegen`：**全部通过，0 错误** |
| `react-router build`（`pnpm build` 的实际命令） | **成功**；有 React Router v8 future flag 警告和 20 余条 sourcemap 定位警告，不影响产物 |
| `apps/web-rr` 行为测试 `node --test test/*.test.ts` | **65 / 65 通过**（含生产 `server.ts` 生命周期、HTTP 行为） |
| 生产 Web 服务器实测 | `GET /%E0%A4%A.js` → **500**（确认 F-05）；`/healthz` → 200；当前构建未生成 `.map` 文件 |
| 正则/模式实测 | 确认 F-01 的坏正则拒绝所有合法 URL；确认 `MEDIA_SRC_PATTERN` 已能匹配 `/api/media/<uuid>`、`/api/v1/media/<uuid>`、绝对 URL |
| 未运行 | `pnpm test:routes`、Playwright E2E（浏览器未安装）、PostgreSQL 集成测试（无数据库）、完整 CI、真实 S3/SMTP/Neon/生产主机 |
| 工作区 | 审阅开始时 `git status --short` 为空；现在只多出本报告文件。验证产生的 `node_modules/`、`apps/web-rr/build/`、`*.tsbuildinfo` 均被 `.gitignore` 忽略 |

说明：F-07 / F-08 / F-11 中的 SQL 条数、内存体量、CPU 空转次数是**静态代码推算或既有审计文档中已记录的实测值**，本次没有重跑负载脚本、查询计数器或浏览器 profiler；F-03 的 PostgreSQL 写偏序、F-06 的跨页漏数、F-02 的双库重放均未在本环境做真实数据库并发复现，属于基于代码路径与现有 issue 的高置信静态判断。

---

## 7. 附：当前 21 个 open issues 与本报告映射

| Issue | 主题 | 本报告 |
|---|---|---|
| #168 | 写作台 prompt/alert、连载、locale、幂等键、收藏/关注 UI | F-12 |
| #167 | 拆分 `postgres.ts` / 去 `any` | F-15 |
| #166 / #165 | 10 个死代码文件 + spike 路由（两条完全重复） | F-16 |
| #164 | GrainCanvas CPU + ScrollSmoother | F-11 |
| #163 | 物化媒体引用表 | F-08 |
| #162 | 文章列表 N+1 | F-07 |
| #161 | 通知铃铛占位 + 英文「写作」 | F-10（另见 F-12 的 i18n） |
| #160 | HeroCanvas 7 处 `canvas.remove()` | F-09 |
| #159 | `server.ts` 畸形 URL / 文件流 / `.map` | F-05 |
| #158 | PostgreSQL 文章 + 媒体库游标漏数 | F-06 |
| #157 | slug 冲突后幂等重放 409 | F-02 |
| #156 | 媒体删除开关 + PostgreSQL 写偏序 | F-03（其中「无告警日志」已过时） |
| #155 | `.gitlab-ci.yml` 三重失效 | F-04 |
| #154 | 写作台链接正则 | F-01 |
| #146 | 媒体删除漏检版本化 URL/头像与竞态 | F-03（漏检部分已在本快照修复，竞态仍在） |
| #137 | 幂等键文章 slug 冲突无法重放 | F-02 |
| #133 | PostgreSQL 毫秒截断漏数 | F-06 |
| #92 | 平滑滚动吞点击 | F-11 |
| #72 | 审核/举报/角色模型 | F-20 |
| #64 | 无性能基线 / SQLite 容量未知 | F-19 |

另：`docs/audit/backend-review-2026-11.md` 的 B1–B5、C1–C4、D1–D4 大多仍未处理，分别映射 F-07/F-08/F-23/F-22/F-21；A1–A3 已修复，E1/E2（Postgres 启动迁移检查、favicon）也已落地。
