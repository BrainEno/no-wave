# 后端核查报告（2026-11-02）

范围：`apps/api`（REST API + 应用/领域/持久化层）与 `packages/web-http`（浏览器侧代理层）。
不含：`apps/web-rr` 页面组件、`packages/web-ui` 客户端逻辑、E2E。

> **状态（2026-11-02 更新）**：第 1 节 A1、A2、A3 三项已修复并合并，
> 每项都带回归测试（见各条下的「已修复」）。第 2 节的 B1/B2（性能）与
> 第 3、4 节的观察项**尚未处理**，是后续工作的主体。

---

## 0. 总体判断

后端的安全基本面是**扎实的**：身份只从 `Authorization` 头解析、资源级授权在持久化层重复校验、
密码用 scrypt 且未知用户同样付 KDF 代价、刷新令牌轮换带重用检测、出站错误统一 sanitize、
媒体上传强制重编码并在读取时校验 sha256。这些都是容易做错的地方，目前做得对，**重构时不要破坏**。

真正需要处理的不是"有没有漏洞"，而是三类工程债：

1. 一处笔误导致连接去同步风险（1 行修复）；
2. 限流策略表和路由表是两份独立清单，已经漏了 5 个写端点；
3. 两个查询放大点（列表 N+1、媒体引用全表扫描），已实测，是接下来性能工作的主要收益来源。

---

## 1. 已确认缺陷

### A1. `readRawImageBody` 正则多了一层转义（建议 P0，1 行修复）

`apps/api/src/transport/rest/http.ts:372` 和 `:376`：

```ts
/^\\d+$/          // ← 匹配的是「反斜杠 + 1 个以上字母 d」，任何数字串都不匹配
```

同文件 `readJsonObject`（`:204`、`:216`）写的是正确的 `/^\d+$/`，说明这是笔误。

后果：

- 声明 `content-length > 8 MiB` 时的快速 413 分支**永不触发**。流式字节计数仍会兜底，
  所以不会造成内存失控，但会先把最多 8 MiB 缓冲进内存再拒绝。
- `hasUnconsumedBody` 恒为 `false`，因此 **415 响应不会带 `connection: close`**，
  而该请求的 body 从头到尾没有被读取 → keep-alive 连接上残留请求体，
  可能被后续请求当作下一条请求的前半段解析（连接去同步 / 请求走私）。

实测：

```
/^\d+$/.test("123")   → true
/^\\d+$/.test("123")  → false
/^\\d+$/.test("\\123") → false
```

修复：两处改为 `/^\d+$/`，并补一条回归测试断言「图片 415/413 时 `closeConnection === true`」。

**已修复**：`transport/rest/http.ts` 两处正则改回 `/^\d+$/`；新增
`transport/rest/image-body.test.ts`（7 条）。已验证该测试对原始缺陷敏感 ——
把正则改回 `/^\\d+$/` 后，「声明超限的 413」和「415 不关连接」两条会失败。

### A2. 五个写端点完全没有限流（建议 P0）

`application/rate-limit.ts` 的 `endpointFor()` 是一张手工维护的路径清单，
与 `transport/rest/routes.ts` 的 `REST_ROUTES` 两份独立维护。
我枚举了路由表里所有写方法并检查 `resolveWriteRateLimitPolicy`，**没有命中任何策略**的有：

| 端点 | 备注 |
| --- | --- |
| `DELETE /api/v1/articles/:id` | 删除文章；会连带写最多 200 条通知，最该先补 |
| `POST /api/v1/articles/:id/restore` | 恢复文章 |
| `DELETE /api/v1/me/media/:id` | 每次会跑一次全量引用扫描（见 B2） |
| `PUT /api/v1/featured` | 编辑权限，但仍是无节流写 |
| `PUT /api/v1/users/:id/role` | 编辑权限 |

**不属于缺口**（由 identity 服务自带限流，且设计上先于通用限流执行）：
`POST /api/v1/auth/*`、`PUT /api/v1/me/password`、`PUT /api/v1/me/email`、
`POST /api/v1/me/email-verification`、`DELETE /api/v1/me/sessions[/:id]`。

修复分两步，缺一不可：

1. 给上述 5 个端点补 `POLICIES` 条目；
2. **把这次的枚举固化成测试**（例如放进 `transport/rest/routes.test.ts`）：
   遍历 `REST_ROUTES` 的写方法，断言每个都有 policy，或在一份显式的
   「由 identity 限流」白名单里。否则下一次加端点还会再漏一次。

**已修复**：新增 `article.delete` / `article.restore` / `media.delete` /
`featured.set` / `user.role.set` 五个策略；豁免清单 `IDENTITY_THROTTLED_ROUTE_IDS`
导出为常量，覆盖率测试固化在 `application/rate-limit.test.ts`（断言每个写路由
要么有 policy、要么在豁免清单里，且清单本身不含失效 id）。已验证该测试对
「删掉某个 policy」敏感。

### A3. SQLite 部署下私信通知永远不会被投递（建议 P0，需先做决策）

`sqlite-conversation-store.ts:218` 在 `persistMessage` 里写了 `outbox_events`（`message.created`），
但两个消费入口都硬要求 PostgreSQL：

- `notification-worker.ts:111` — `if (!process.env.DATABASE_URL) throw ...`
- `notification-drain.ts:57` — 同样

而 SQLite 适配器已经实现了完整的 `claimOutboxEvents` / `markOutboxDelivered` / `rescheduleOutboxEvent`。

结论：SQLite（默认 provider）下，**私信通知一条都发不出去，且 `outbox_events` 无上限增长**。
要么在文档里明确「私信通知仅 Postgres 可用」，要么让 `runOutboxDrain` 走 provider 抽象
（`createPersistenceRuntime` 已经能给出任意 provider 的 adapter，改造成本不高）。

**已修复（按第二种方案）**：`notification-worker.ts` 与 `notification-drain.ts` 都改为
通过 `createPersistenceRuntime` 解析 store，删掉 `DATABASE_URL` 硬要求；
`worker_started` / `outbox_drain_started` 日志带上解析出的 provider。
积压指标原本是 worker 里一段 PostgreSQL 专属 SQL，改为新的持久化端口方法
`outboxBacklog()`，两个适配器各自实现，指标在 SQLite 下同样可用。
回归测试：`outbox-drain.test.ts` 新增「SQLite 部署下一条私信真的变成通知」
（含收件人各一条、发件人零条、outbox 清空）；`persistence-adapter-contract.test.ts`
新增 `outboxBacklog` 的双适配器契约测试。
文档同步：`docs/operations/notification-worker.md`（原文档称「没有 SQLite 模式」，
与代码中 SQLite 早已具备完整 outbox 的事实不符）、`portable-stack.md`、
`deployment/vercel.md`。

---

## 2. 性能 / 扩展性隐患（均已实测）

### B1. 列表序列化 N+1 —— 当前最大的单点放大器

`serializers.ts` 的 `serializeRestArticle` 对**每一篇**文章发 3 个查询
（作者档案 + 分类 + 标签），`serializeRestArticles` 用 `Promise.all` 并发，但总量不变。

实测（SQLite，每篇 1 个 block）：

```
listPublishedArticles(limit=50)   -> SQL statements: 1
serializeRestArticles(50 items)   -> SQL statements: 150  (3.0 / 篇)
```

`limit=100` 时即 **301 条 SQL**。而 `getAuthorProfile` 自身还带 3 个相关子查询
（粉丝数、关注数、是否关注）加一个语言偏好子查询，单条就不便宜。
在 SQLite 下这些是**同步阻塞事件循环**的。

优化方向（按性价比）：批量取作者（`WHERE user_id IN (...)`）+ 批量取分类 + 批量取标签，
三次往返取代 3N 次；或让列表接口返回精简卡片投影，详情接口再取全量。

### B2. 媒体引用扫描每次都全表拉正文

`media-assets.ts` 的 `listLibrary` 和 `deleteAsset` 都会调用
`store.listArticleContentForMediaScan()`，把**所有文章的所有译文正文**一次性拉进内存再正则扫。
一次 SQL，但数据量是全文。

实测（2000 篇、每篇约 4000 字）：

```
listArticleContentForMediaScan: 2000 rows, 7.7 MiB of bodies, 147ms; regex pass 4ms
```

约 2 万篇就是 ~77 MiB / ~1.5 s **每次调用**，SQLite 下同步阻塞。
`GET /api/v1/me/media` 和 `DELETE /api/v1/me/media/:id` 各调一次。

优化：建 `article_media_refs(asset_id, article_id)` 物化表，在文章保存/删除的**同一事务**里
增量维护，扫描退化为一次带索引的 join。注意权衡：引用关系必须和文章保存同事务，
否则会出现「能删掉正在被引用的图」这个正确性回归。
退一步的过渡方案：先加 `WHERE content_blocks LIKE '%/api/media/%'` 缩小候选集。

### B3. 删文章的通知写入是串行逐条

`services.ts` 的 `notifyCommentAuthors` 对最多 200 个评论者 `await` 逐个 `createNotification`，
每个都是独立事务，发生在删除请求内部。改成一次批量插入（或至少小批量）。
这里的「吞掉所有异常」是刻意的（注释说明了理由），但见 C4。

### B4. 搜索与深翻页

Postgres 侧 `listPublishedArticles` 的 `query` 分支会对全部已发布文章逐条
`jsonb_array_elements` + `ILIKE`；trigram 索引覆盖 title/summary，覆盖不到 content_blocks 这一路。
`offset` 上限 10 万，深翻页代价线性增长。游标分页（`cursor`）已经存在，
建议对 `sort=latest` 之外的排序或对超过阈值的 offset 直接 400。

### B5. 观察项

`authenticatedUser` 每个带 `Authorization` 的请求都查一次 `revoked_sessions`。
当前规模不是瓶颈；若要优化，可加进程内「已吊销 token id」短期缓存（≤ access token TTL），
但要考虑多实例一致性，收益不大，先只观察。

---

## 3. 健壮性 / 一致性

### C1. SQLite 同步驱动（定位正确，但要在文档里钉死）

`node:sqlite` 的 `DatabaseSync` 在所有查询上阻塞事件循环；`BEGIN IMMEDIATE` + `busy_timeout=5000`
意味着写冲突会让整个进程停等。项目已在启动时按 provider 打 warn，并把 Postgres 标为生产推荐
（`describePersistenceRuntime`），这个定位是对的。若 SQLite 要继续承载多人部署，
需要限制并发或明确「单写者」。

### C2. 清理任务搭便车在写请求上

`pruneExpiredIdentityState`（每 128 次限流操作）和 `sweepTombstones`（每 32 次文章写）
都只在有人写的时候跑。好处是不需要调度器；坏处是**低流量实例上
`revoked_sessions` / `outbox_events` / 过期 tombstone 会长期不清**。
建议运维文档补一条「低流量实例需定时触发一次 drain/prune」。

### C3. `pruneExpiredIdentityState` 里 capture 调用位置易碎

`sqlite-identity-store.ts` 中 `migrationCapture.captureInTransaction` 在删除
`auth_identity_tokens` **之前**执行，而 `changes` 里已经包含了这些行的 delete 记录。
同一事务内顺序无副作用，但读起来像漏了；建议把 capture 移到全部 DELETE 之后，
避免以后有人在这中间插语句时被顺序坑到。低优先级，纯可维护性。

### C4. 静默失败路径没有指标

`notifyCommentAuthors`、`sweepTombstones`、媒体孤儿清理都刻意吞异常，但都没有计数器。
目前只有 mail 有 `api_identity_mail_deliveries_total`。这三条路径出问题时无人知晓 ——
建议至少加 `api_tombstone_notification_failures_total` 和 `api_tombstone_purge_failures_total`。

---

## 4. 安全面核查结论

### 做得对、重构时不要破坏的

- **JWT**：HS256 + `timingSafeEqual`；typ/iss/aud/iat/exp/nbf/jti 全查；TTL 上限；
  base64url 规范化回验；拒绝 `crit` 与 `b64:false`。
- **身份来源**：只从 `Authorization` 头解析；`assertResourceOwner` /
  `assertConversationParticipant` 不接受客户端传入的 sender id。
- **资源级授权在持久化层重复校验**：删/改文章、删评论都比对 owner，不依赖传输层。
- **密码**：scrypt（N=2^15, r=8, p=3），未知用户付同样的 KDF 代价；改密/改邮箱都要旧密码。
- **会话**：`sid`（session）与 `jti`（access token）分离，刷新轮换带 `used_at` 重用检测
  → 吊销整个 token family；改密码只保留发起请求的 session。
- **幂等**：文章/评论/会话创建带 `Idempotency-Key` + request fingerprint，冲突返回 409。
- **错误与日志**：`sendServiceError` 只映射已知 `DomainError`，其余统一 500 无细节；
  日志不记 URL / 请求头（web-http 的 `safeLogPath` 只保留 path）。
- **代理层 cookie**：HttpOnly + SameSite=Lax + `Secure` 跟随 `x-forwarded-proto`；
  access cookie 只作用于 `/api/authoring`，refresh 只作用于 `/api`；所有写操作强制 Origin 精确匹配 Host。
- **媒体**：上传强制 sharp 重编码为 WebP，限制像素/尺寸/动图；读取时校验 sha256 与字节数；
  响应带 `nosniff` + `CSP: default-src 'none'; sandbox`。
- **限流 key**：HMAC 派生，不含资源 id；IP 只用 TCP 对端地址，不信任 XFF。

### 需要注意的

- **D1. IP 限流在反代后退化**：`request.socket.remoteAddress` 在 Vercel / 反代后面所有请求同源，
  IP 桶变成一个共享大桶（代码注释已说明）。建议在文档里明确，或提供 `TRUST_PROXY_HOPS` 选项。
- **D2. 注册接口泄露邮箱是否已注册**：重复邮箱返回 409 CONFLICT。代码注释里承认了这是
  为注册体验做的取舍（`forgot-password` 正确地做到了不泄露）。如果这在你的威胁模型里不可接受，
  需要改成「注册也返回 202 + 发验证信」。**这是一个显式的产品/安全取舍，建议在 ADR 里留痕。**
- **D3. `refresh` 只按 IP 限流**（120/15min），没有按 refresh token 维度的桶
  （`reset-password` 有 `reset-password:token`）。加一个 token 桶会更稳。
- **D4. `EDITOR_USER_IDS` 是引导后门**：`isEditor` 先查这个环境变量再查 role 列。
  务必确认生产环境为空 —— 非空等于把编辑权限交给一个环境变量。

---

## 5. 建议的后续优化顺序

**P0 — 小、明确、有回归风险**

1. 修 A1 正则（1 行 + 1 条回归测试）。
2. 把「路由表 × 限流策略」覆盖检查固化成测试，再给 5 个漏掉的写端点补策略（A2）。
3. 决策 A3：SQLite 的私信通知 —— 要么文档化为「仅 Postgres」，要么做 provider 无关的 drain。

**P1 — 性能，收益最大**

4. B1 列表序列化批量化（作者/分类/标签各一次批量查询）—— 当前最大的单点放大器。
5. B2 媒体引用关系物化。

**P2 — 可观测与运维**

6. C4 给静默失败路径加指标；C2 文档化低流量实例的清理触发方式。
7. B3 通知写入批量化。

---

## 6. 本次实际执行的检查

### 修复前（审计阶段）

| 检查项 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 成功（sandbox 为 Node 22.22.3，项目要求 `>=24 <25`，用 `--config.engine-strict=false` 绕过 engine 检查） |
| `tsc --noEmit`（`tsconfig.json` + `tsconfig.strict.json`） | 通过，0 错误 |
| API 单元测试（`test:unit` 的 27 个文件） | **276 passed / 0 failed** |
| 持久化 + 安全 + 路由测试（21 个文件） | **209 passed / 1 failed / 39 skipped** |
| 实测脚本（N+1 计数、媒体扫描体量、限流覆盖枚举） | 见 B1 / B2 / A2，脚本在 `/tmp`，**未写入仓库** |

关于那个 1 failed：

- 失败用例是 `apps/api/src/persistence/sqlite.test.ts:61`
  「SQLite binding and row types stay explicit across null, number, text, and blobs」。
  原因是 **Node 22 的 `node:sqlite` 不支持绑定 boolean**（Node 24 支持），
  项目 `engines` 要求 Node >=24。**这是沙箱 Node 版本造成的，不是代码缺陷**；
  我无法在 Node 24 上复核，需要在 CI 或 Node 24 机器上确认这条是通过的。
- 39 个 skipped 全部是 Postgres 集成用例（`# SKIP TEST_DATABASE_URL is not set`）。

未运行：`pnpm test:e2e`（Playwright）、Postgres 集成测试、`web-rr` 生产构建。

本次未修改任何代码，工作区保持干净（`git status --porcelain` 为空）。

### 修复后（A1 / A2 / A3）

| 检查项 | 结果 |
| --- | --- |
| 全量 `tsc --noEmit`（`web-http`、`web-ui`、api 两个 tsconfig、`scripts`、`e2e`） | 通过，0 错误 |
| 根 `pnpm test` 全集 | **685 tests / 597 pass / 1 fail / 87 skipped** |
| API `test:unit` | **286 pass / 0 fail**（修复前 276） |
| 那 1 个 fail / 87 个 skip | 与审计阶段完全相同：fail 是 Node 22 的 boolean 绑定（Node 24 才支持），skip 全是 `TEST_DATABASE_URL` 未设置的 Postgres 集成用例 |

A3 的端到端实测（真实 SQLite 文件，非 mock）：

```
$ DATABASE_PATH=/tmp/nw-live/live.sqlite node src/persistence/notification-drain.ts
{"event":"outbox_drain_started","provider":"sqlite",...}
{"event":"outbox_drain_completed","batches":2,"claimed":1,"delivered":1,"failed":0,"stopReason":"empty"}
exit code: 0
→ bob: 1 notification, carol: 1 notification, alice (sender): 0, outbox backlog: 0

$ DATABASE_PATH=... node src/persistence/notification-worker.ts
{"event":"worker_started","provider":"sqlite",...}
{"event":"outbox_batch_completed","claimed":1,"delivered":1,"failed":0}
$ kill -TERM <pid>
{"event":"worker_stopping"}   → exit code 0
→ alice: 1 notification, outbox backlog: 0
```

未运行（与审计阶段相同）：`pnpm test:e2e`（Playwright）、Postgres 集成测试、
`web-rr` 的 `react-router typegen` + 生产构建。CI 需在 Node 24 上复核那条 boolean
绑定用例。
