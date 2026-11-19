# #331 默认关闭的 durable Notion job：审阅与本轮验证记录

## 交付范围与风险

高风险：外部 AES 密钥、敏感来源输入、数据库租约、并发事务和 Cookie 代理。
基线为 `5d69cd9ea37a7d2da60f99f1b645cfe35a090640`，只在
`arena/fb8fb3f0-no-wave` 工作。PR #367 的历史 802 行不计本轮。

本轮实现 #331 的有限 durable job 子集，**不关闭整个 #331**。默认关闭，不自动调度，
没有生产 enablement、Notion token custody、UI 切换、崩溃 mutation replay 或完整
image/page checkpoint resume。ADR 0041 仍为 Proposed，不把它写成已批准的生产决策。

## 可观察行为与文件

- `application/notion-durable-jobs.ts`：固定配额、幂等 owner/key hash、严格状态／
  报告投影；状态不含源标题／ID／URL／正文、lease、plan、密文或原诊断。
- `application/notion-job-service.ts`、`infrastructure/notion-job-{keys,settings}.ts`：
  有效既有签名预览才可入队；外部单 key 或最多三项的 staged ring；原 15 分钟
  期限不延长，32-byte key/AAD 绑定 owner/job/deadline/kind/key id。缓存图片失败与
  成功结果，每次任务最多八次复制。解密采用 fatal UTF-8，临时 bytes 清零。
- 两个 `*-notion-jobs-store.ts` 及 SQLite `0025` / PostgreSQL `0038`：加密队列、
  原子 claim、lease/progress、取消、保留和 payload 删除；运行租约失效只能 interrupted，
  永不重新排队。SQLite 的 immediate transaction 与 PostgreSQL 的 admission lock /
  row locks / `SKIP LOCKED` 保留各自物理语义，不用同一个假 provider 测试替代。
- 两个 `*-import-store.ts` 和既有 importer：每作品事务开始／结束都验证同一 job
  fence，PG 取锁后读取 wall clock，drain deadline 也进入事务；取消／超时的晚到
  操作不能通过旧 preflight 写入。文章／标签／provenance 原子性和媒体 owner 不放宽。
- `application/notion-job-{drain,check}.ts`、`persistence/notion-job-command.ts`：
  独立有限 `drain|inspect|check|sweep`。check 是只读、逐份、有界 key/signature/
  generation 检查，不 claim／续租／修复／刷新来源。权威轮换检查要求先停写。
- `transport/rest/routes/notion-jobs.ts`、`application/notion-job-poll.ts`：认证 start /
  list / status / cancel；原 `Idempotency-Key` 的独占只读 GET selector 能找回失去响应
  的任务，即使 plan 过期或新提交关闭。强 ETag／无 body 304、最多五秒等待、owner/job
  single-flight，最多两个物理读；断线仍保留物理容量。显式停机在原总预算内 drain，
  预算耗尽保留 forced/nonzero 事实。
- `packages/web-http/src/notion-jobs.ts`、`forward.ts` 与两条薄 RR 资源路由：
  Cookie-only、Origin、可选 expected actor、原协调 refresh、安全响应头和本地 Location，
  不增加 UI，不允许上游 cookies/raw 5xx 逃逸，不自动 retry mutation。
- `provider-migration-transfer.ts`：dry-run 与真实 transfer 都拒绝源／目标活跃 jobs；
  operational jobs 不进入 domain copy。停写仍是 operator 条件，不宣称跨库原子切流。
- 合法完整 8 MiB 加密输入暴露出既有 repeated-group base64 正则的栈溢出拒绝；
  改为有界平坦字符检查与原 canonical roundtrip。完整 8 MiB 在两个真实 provider
  执行通过，没靠降低 bundle／页数／图片／HTTP 限额躲开问题。

同步导入、既有 signed plan/revision、八次图片界限、Cookie 401/refresh 边界、
#366 的大合法文章列表／SSR／流式与取消能力均保留。

## 复用与不复用说明

先检索 shared-module index、`forwardAuthoringRequest`、authoring/session/body/upstream
handler、`HttpCollectionAdmission`、既有 import plan／per-work commit／image fetch／
AES envelope、持久层 slice 与 lifecycle。复用这些已交付边界，不复制一套认证／
refresh／Notion planner。新模块的差异是 durable owner-bound input/lease、无重放
生命周期以及 bounded conditional status wait；不是新的 Notion 客户端、常驻 worker
或浏览器状态库。原媒体上传接线、薄包装和元数据不计本轮新增行。

## 独立有效新增：800 行

- [主计算器](notion-job-lines.ts)：Babel TypeScript AST/token + 固定基线 Git 实际新增行，
  排除 imports、types、注释／空白／标点，排除全仓基线 TS/TSX 片段和本轮重复片段。
- [语义排除清单](notion-job-line-exclusions.json)：固定原文和行号，进一步排除契约/schema、
  provider/facade/路由接线、静态错误／CLI 帮助、既有媒体接线、通用事务包装及运行时重复。
- [主证书](notion-job-lines.json)：929 个候选减 129 个额外排除，**800**。测试、E2E／
  audit 脚本、文档、配置、生成文件、SQL migrations 均不计。
- [独立验证器](verify-notion-job-lines.ts)：Node 24 类型擦除 + Espree JavaScript token，
  独立核对精确源码 SHA256、Git 新增、全基线运行时片段及本轮运行时去重。
  [结果](notion-job-runtime-check.json)：claimed/runtimeConfirmed 均 800，failures=[]。
- 主证书 SHA256：`b1011742beb0090e0e8bfc523110bf23b966fd91a8c4fdb313bd33fc4f4a1d0c`。
  初步候选 804／801 不是最终口径，最后再排除转移错误静态文案一行后为 800。

复算（这些审计工具本身不计生产行）：

```sh
node docs/audit/notion-job-lines.ts > /tmp/notion-job-lines.json
cmp /tmp/notion-job-lines.json docs/audit/notion-job-lines.json
node docs/audit/verify-notion-job-lines.ts
```

## 本地实际结果（不是远端 CI 替代品）

Node 24.22.3、pnpm 10.20.0；真实 PostgreSQL 17.11，独立测试 schema。
记录保留在忽略的 `verification/notion-jobs/`，不把大日志或数据库提交 Git。

| 实际执行 | 通过 / 失败 / 跳过 | 说明 |
| --- | --- | --- |
| `pnpm test`（最后一轮） | 2425 / 0 / 464 | 根分组无外部 PG，PG 等环境条件跳过如实保留 |
| `TEST_DATABASE_URL=… pnpm --filter @bot-thk/api test:integration` | 772 / 0 / 0 | 完整真实 PG 分组，含 SQLite 对照、shared Web 刷新等；不靠根分组的 skip 验收 |
| `pnpm test:web`（串行无 PG 轮） | 281 / 0 / 18 | 生产 Web build + HTTP 行为；不把 18 项 PG 条件跳过当通过 |
| `TEST_DATABASE_URL=… pnpm --filter @bot-thk/web-rr test` | 299 / 0 / 0 | 额外完整实跑 Web 的全部 PG 条件测试；其中三项 `refresh-session.test.ts` 并不在 API integration inventory，不能用该分组的 772 冒充覆盖 |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | 全部 exit 0 | 全仓类型、现有严格 lint 与 scoped format，未放宽门禁 |
| `pnpm build` / `pnpm test:routes` / `pnpm --silent verify:publish --json` | 全部 exit 0 | 真实生产构建、路由与无邮件发布可见性 |
| `pnpm audit --audit-level high` | exit 0 | 完整 dev + prod 树；仍有 1 项 low，未增加依赖或忽略 advisory。另完整 `pnpm audit --json` 实跑 exit 1，唯一项为既有 `@babel/core` low（GHSA-4x5r-pxfx-6jf8），并非零漏洞声明 |
| 生产 API + 生产 Web + 独立 CLI HTTP 场景 | exit 0 | Cookie-only preview/start/lookup/304/drain/succeeded/payload NULL；伪造 browser bearer 拒绝，不冒充浏览器测试 |
| `playwright … --list` | 发现新增 1 项 | 这里只是发现；实际浏览器执行由本轮远端 shard 验证 |
| 主证书 + 独立运行时核对 / `git diff --check` | 全部 exit 0 | 生产计数与 patch 格式 |

高风险 RED 记录包括：原键回执找不到、期限后晚到写入、ring 成员 key 泄漏、满额
base64 解码失败、物理 poll 容量超卖、损坏输入反复卡住队首、目标 dry-run 未检查活跃
jobs 和停机缺少物理 drain。对应修复后的回归已实际通过。

失败不隐藏：早期根分组有 7 项 schema/route/契约清单不匹配，已修复并完整重跑为零；
第一次完整 Web 有 3 项 `ERR_MODULE_NOT_FOUND`（验证命令并行重建同一 build 目录），
串行 `pnpm test:web` 后 281/0/18，没有删除／跳过／减弱这些测试。
首轮远端新浏览器场景也实际失败：夹具只设置 access cookie，缺少既有 private shell
的 session marker，实际重定向登录页。修正为调用真实 BFF register 取得三种正确
scope 的 cookies，并增加 URL／cookie 名称／凭据不进入响应体断言；没有放宽页面门禁。
该失败 head 不作为通过证据，最终 head 必须重新通过所有远端 jobs 后才创建 PR。

## 远端发布前门禁与未授权事项

沙箱没有 Docker／Chromium；未冒称本地容器或浏览器通过。CI / CodeQL 增加显式
`arena/**` push 触发（保留全部既有 jobs、审计、真实 PG、浏览器和容器门禁），是为遵守
**最终 source head 的实际 CI 通过后才开 PR**。远端精确 run/head、各 job 结果和与
最新 main 的实际冲突检查见 PR 说明；本记录不借旧 PR #367 的成功作为本轮验收。

没有生产 key provisioning/rotation、部署／主机别名调整、生产数据库操作、merge 或
关闭 #331。输入 NULL 不等于清除备份／WAL；过期物理清理由后续有界交互或 sweep
触发；crash commit 与 progress ack 之间仍须人工检查。真实托管、告警接线、回滚、
Phase 6 责任人和剩余 checkpoint/UI 工作继续留在 #331。

本轮无新增依赖，lockfile 不变；新增 package script 仅调用一次性命令。变更仅关联
该 slice、必要安全回归、生成契约／inventory、审计和 CI 预审触发；无真实密钥、
用户数据、生成大产物或无关改动进入 patch。
