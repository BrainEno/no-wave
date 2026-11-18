# Notion durable import jobs：默认关闭的操作切片

本轮只实现 #331 的 durable job 连接；**没有生产启用、完整 checkpoint resume、
UI 迁移、真实托管资格或新常驻 worker 角色承诺**。设计边界见
[ADR 0041](../architecture/decisions/0041-default-off-notion-import-jobs.md)（Proposed）。
不要因命令可执行就视为 owner 已批准部署／密钥轮换。

## 使用前

1. 普通同步导入、签名 dry run 和每作品事务原子性保持不变。作者先在原同步端点取得
   有效 `planToken`，才可以明确选择新队列端点。浏览器 UI 仍使用原流程。
2. SQLite / PostgreSQL 都先按既有方式应用迁移（新增 SQLite `0025` / PostgreSQL
   `0038`）。独立 job 命令自身不迁移；沿用 API runtime 的显式
   `DATABASE_AUTO_MIGRATE=true` 例外时，迁移是该既有设置的效果，不是 job 自动行为。
3. 由 owner 在数据库外保存随机 32-byte AES key，canonical base64 编码。不得复用
   JWT、Notion、refresh、drain 或 metrics secret，不得把真实值贴入 issue／命令日志。
   API 和执行命令必须使用一致 key ring；签名配置、数据库 generation、原输入期限也
   必须匹配。工作进程与数据库时钟须同步，deadline/预览过期都不是无限重试窗口。
4. 只有显式 `NOTION_IMPORT_JOBS_ENABLED=true` 才允许新入队和 drain。默认关闭时，
   认证 list/status/原键查询/cancel 仍可用，不要求保留解密 key。启用但 key 配置错误
   会在启动时拒绝；需要只读恢复时先明确关闭新提交，而不是填假 key。

## 配置（不要同时配置单 key 和 ring）

| 设置 | 意义 |
| --- | --- |
| `NOTION_IMPORT_JOBS_ENABLED` | 仅 `true` / `false`；默认未启用 |
| `NOTION_IMPORT_JOB_KEY` | 单 key 模式，canonical base64 的 32 bytes；逻辑 key id 为 `primary` |
| `NOTION_IMPORT_JOB_KEYS` | 替代单 key 的 `id:base64,id:base64`；最多三个，id 为小写字母／数字开头，后续小写字母／数字／`_`／`-`，最长 32 |
| `NOTION_IMPORT_JOB_ACTIVE_KEY` | ring 模式必须显式指定存在的 id；新提交只用此 key |
| `NOTION_IMPORT_DRAIN_MAX_JOBS` | 1..10，默认 1；串行，不是并发数 |
| `NOTION_IMPORT_DRAIN_DEADLINE_MS` | 1000..900000，默认 300000；协作式总期限 |

单 key 改为 ring 时保留 `primary` 的 id 和原 bytes，否则旧 envelope 的认证上下文
不同。仅修改 active id 不会重加密旧输入。移除旧 key 会令仍使用它的输入无法打开，
执行后失败并删除输入；**不会尝试其他 key 猜测、刷新 plan 或自动重试 mutation**。

## 独立有限命令

```sh
pnpm --filter @bot-thk/api jobs:notion --help
pnpm --filter @bot-thk/api jobs:notion inspect
pnpm --filter @bot-thk/api jobs:notion check
pnpm --filter @bot-thk/api jobs:notion drain
pnpm --filter @bot-thk/api jobs:notion sweep
```

- `inspect`：不需 AES/JWT 配置，仅输出固定状态计数、密文总字节、最老 queued 年龄、
  过期输入／租约／状态数量。不先清理，因此能观察积压。
- `check`：只读逐行检查最多 32 个活跃输入，默认 30 秒协作期限；每次只持有一份输入。
  需要外部 keys 和 API 签名设置，但不要求开启新提交。验证解密、canonical 内容
  边界、签名、owner/hash、原期限、页数、fingerprint 与数据库 generation。
  输出 ready/expired/unreadable/invalidInput/stalePlan 和 active/previous/unknown
  key 计数，不输出 id、账号、key id、URL、标题或 plan。未完整检查／失效输入／
  generation 中途改变均非零退出。它不 claim、续租、sweep、修复或执行文章写入，
  也不保证之后的 revision/ownership 仍匹配。**为轮换／恢复验收须先停掉新提交和 drain**；
  一边写入一边检查不是一致快照资格。
- `drain`（无参数时的默认命令）：必须显式启用，取得一个 job 后运行既有 importer，
  每次最多八次图片复制。只输出聚合结果。失败、interrupted、不可用或总期限到达
  非零退出；SIGINT/SIGTERM 停止接纳新 work，等待物理操作与 heartbeat 结束后关资源。
  内部执行期限也送入数据库事务 fence，晚到的写入不能只靠旧 preflight 放行。
- `sweep`：不需 AES/JWT，queued 输入过期转 expired，running 租约／输入过期转
  interrupted，删除密文；删除保留期已过的终态记录。永不重新排队。

命令不是硬实时进程终止器；不合作的数据库／存储操作可能延长返回时间。主机必须另设
有限终止预算和异常恢复责任，不可在物理操作未收尾时宣称资源已安全关闭。命令沿用
API 的媒体配置与可信 Notion 图片 host/type/byte 边界；没有自动删除孤立媒体。

## HTTP 与断线恢复

所有 API 请求均需有效的未撤销 bearer；BFF 只使用 HttpOnly cookies。身份来自已验证
会话，body 不接受 owner、actor、lease、Notion credential。公开 URL 不得带 plan/key。

| API | BFF | 行为 |
| --- | --- | --- |
| POST `/api/v1/imports/notion/jobs` | POST `/api/authoring/notion-jobs` | `{bundle, planToken}` + 16..128 ASCII 字母／数字／`_`／`-` 的 `Idempotency-Key`；202、私有 Location |
| GET 同 collection | GET 同 collection | 最新在前，limit 1..20；不接收其他 query |
| GET collection + 原 `Idempotency-Key` header | GET collection + 同 header | 只返回该 owner/key 的零或一条；不能同时使用 limit；不创建／重放任务 |
| GET `/:jobId` | GET `/:id` | owner 状态，缺失与外人的任务同为 404 |
| DELETE `/:jobId` | DELETE `/:id` | 幂等取消，终态不改；不撤回已完成作品 |

POST 精确同 owner/key/bundle/plan 在预览有效期间返回同一 status，不因重试增加任务；
同 key 不同请求为 409。POST 在查询幂等状态前仍须验证 plan。若提交响应丢失、预览
已过期，**使用原 key 的只读 GET 查询**，不要换 key 盲重放。保留记录删除后不再有该
任务回执，需要作者先检查作品、重新预览，不能把未找到误当成此前没有提交成功。

状态只含安全事实，`completed` 是最后确认的报告页数。进程可能在文章 commit 后、
报告确认前崩溃；因此 interrupted / cancelled / failed 必须检查自己的作品和媒体后
重新预览。`recovery` 是操作指引，不是自动清理或恢复动作。

状态响应有强 ETag；`If-None-Match` 只允许单一匹配格式，不支持 `*`／weak／列表。
可额外使用 `Prefer: wait=0..5` 做最多五秒的请求内条件等待（ETag 不匹配立即返回），
未变则无 body 的 304；均 `no-store`，活跃状态 `Retry-After: 2`。
默认每 API 最多 16 个 owner/job 组、每组四个等待者、两个物理 status read。
显式 API shutdown 会先拒绝／结束等待者，并在既有总停机预算内等待物理查询及入站 handler；
超过预算仍报告 forced/nonzero，不把关闭的浏览器连接当成数据库已经收尾。
断线、超时不会释放仍在运行的查询；过载／查询不可用 503 后只重读状态，不重放导入。
REST 提交另有两个物理 body/handler 槽；普通列表、认证和同步导入限额不提高。

## 固定容量与隐私

- 原输入 bundle ≤8 MiB、plan ≤512 KiB、≤200 页、≤八次图片尝试。
- 单任务密文 ≤12 MiB；账号／全局密文 ≤24 MiB／64 MiB。
- 账号／全局活跃 ≤2／32；保留行 ≤20／1000；状态报告 ≤128 KiB。
- 原 15 分钟签名 plan 期限从不延长。输入到期立即不能解密或写入；实际 NULL／删行在
  下一次 sweep、读写维护交互发生，若无人运行这些交互则不承诺准点物理删除。
- 状态仅保留至输入期限后 24 小时；不含源页面 ID、标题、URL、正文、raw diagnostics、
  owner、租约、plan 或密文。备份/WAL/磁盘副本不因 SQL NULL 自动擦除，需独立保留策略。

## 轮换、恢复与 provider transfer

1. 获得 owner 的明确运维授权；本 PR 不执行生产 key 变更。
2. 停新提交与 drain，备份数据库及外部 key（分开保管）；只读 inspect/check 记录聚合
   状态与旧 key 的使用情况，不把 key bytes 打进记录。
3. 显式部署包含旧／新 key 的 ring，新 key 设 active；以一次性测试输入在隔离环境
   验证新旧均可打开、错误 key 拒绝、删除输入、取消和数据库 transaction fence。
4. 完成或取消旧输入、运行 sweep，再用**只保留计划中 keys 的进程**执行 check。
   完整 check 通过也不替代停写条件和备份恢复演练；运行中的 worker 不会热更新 key。
5. key 丢失／密文损坏：关闭新提交，使用不需 key 的 status/原键查询/cancel/sweep；
   不重置 running 为 queued，不编造成功，也不把恢复旧数据库等同于恢复写入资格。

Domain provider transfer 故意不复制 `notion_import_jobs`。源或目标有 queued/running
时，即便 dry-run 也报 `ACTIVE_IMPORT_JOBS`；先完成／取消／sweep 再停写转移。
终态与密文不随文章搬运。[转移规程](../deployment/provider-transfer-runbook.md)要求
停写双方；该前置检查不是跨数据库原子锁，也不授权在线切流。

## 仍待 #331 完成

真实主机的进程／内存／截止预算和回滚、告警接线与责任人、Phase 6 所有权、完整
image/page checkpoint resume、UI 选择／恢复体验和生产 key 许可。没有这些证据不能
宣称整个 #331 已完成或把默认开关打开。
