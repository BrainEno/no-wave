# 合法文章集合兼容性、读取所有权与测试发现审查

核对日期：2026-11-12。固定基线：`7c3b2c355f63442bba49d4678520aada6271eb7e`。
本页记录本轮实现、独立计数和实际本地验证；当前提交的远端 CI、PR 及 issue 状态由本轮中文 PR 的最终检查记录补充。
这不是合并、部署、修改生产限额或公网托管容量资格的授权。

## 1. 对应问题与修改边界

- **#366**：合法全文集合超过普通 8 MiB 缓冲时不再被整页拒绝。普通响应 fence 不提高，
  文章/数据库/导入/媒体业务限额不降低；默认与显式 full 客户端保留全文、API 顺序、数量和分页。
- **#356**：根、API unit/integration、Web 使用同一套安全递归发现；新测试无需逐一修改 manifest。
  历史 56 个 API unit、32 个 integration 的归属回归快照仍受检查，保留顺序执行、双 reporter、
  非 integration 后缀的 provider contracts、外部通知与跨 Web 刷新测试；inventory 独立遍历兜底。
  根测试不再加载 `.env.local`；需要真实库时显式 export `TEST_DATABASE_URL`。
  `test:all` 继续隔离环境和自有数据库，不解释任意 shell。
- **#353**：历史叙事移到 [历史归档](local-development-history.md)，
  [本地指南](../development/local-development.md) 重排为唯一的 1–9 节，保留命令、排障、已知限制与通知验证。
  两个 README 的 publishing anchor 同步更新，两项回归检查保护结构与链接。

主要实现分布：`packages/web-http/src` 的 collection framing、owned byte slabs、preflight 与 transport；
API 的 `article-page-reader.ts`、`article-reading.ts`、`article-collection.ts`、`json-collection*.ts`、
`json-encoding.ts`、`collection-read-budget.ts`、`settled-reads.ts` 及原生 admission；
`web-ui` 的显式 card 映射与读取标签；测试发现位于 `scripts/lib/test-discovery.ts` / `scripts/test.ts`。
OpenAPI 的源表与生成文档同步修改，不手改生成物冒充契约源。

## 2. 行为、所有权与安全复核

1. **逐项消费，不截短整页**：每 item 8 MiB、envelope 累计 64 KiB，默认最多 100 项；
   多语言作者集合按权威路由最多 300 项。总 decoded fence 从合法项数推导，仍使用 data lane。
   fatal UTF-8、JSON、唯一 envelope key 和完整 EOF 都必须通过，不能返回“前几项成功”。
2. **内存与 backpressure**：惰性 64 KiB owned slabs 防止一字节 chunk 制造无界碎片，也防止 Buffer 复用篡改。
   原生 writer、巨型 adapter chunk 切片和 BFF 重放每次最多 64 KiB；等待下游需求/drain 再继续。
   BFF 只在确认 data 数组后提交成功，预读不超过 envelope 加一个 segment；迟到错误中止流。
   放弃 retained response 时释放 decoder 的已投影结果和捕获 slabs，不能恢复为成功页面。
3. **显式 card**：SSR 使用 `view=card` / `contentProjection=card`，阅读长度和第一段前两条非空诗行保留。
   SQLite iterate、PostgreSQL 一行 callback cursor 在留存前投影；PG 等待 portal 真实收尾并清除 abort listener。
   默认/full、详情和写作读取不是 card；详情的代码、TOC 和朗读不丢失。
4. **双完成 ownership**：原生 API 默认 4 active / 16 queued / 250 ms FIFO 排队；身份、health、detail 和 mutation 独立。
   槽需要 handler 与 native response 都结束。断开客户端不能提前放走仍被 DB 占用的槽，
   未确认的上游 cancel receipt 仍占 Web 物理槽及恢复 probe。
5. **读取与输出分段期限**：读取/metadata 默认 120000 ms；超时可返回固定私有 504，并 abort 合作的 card 查询，
   但不假装数据库已经停止。checkpoint 防止迟到结果继续启动文章/metadata 查询。
   并发 metadata/多语言读取一项失败后仍等待所有已启动分支真实 settle，再保留首个失败；没有自动重试。
   随后的编码/drain/finish 有独立默认 120000 ms 输出期限；实际 UTF-8 item/envelope/chunk fence 继续执行。
   headers 后失败销毁不完整 JSON；迟到错误不能写第二个 envelope，也不能破坏已经 end 的错误响应。
6. **既有安全不变**：cookie-only、同 token `/me`、actor 轮换重查、业务 4xx/revision 恢复、
   后端媒体归属、签名 import plan、每作品原子性不改。API 已配置而失败不能回退 fixtures。
   指标只有固定 view/mode/outcome/reason，不能包含正文、账号、URL、token 或错误原文。

配置范围、指标语义和限制见 [运行边界 §4.1](../architecture/web-upstream-timeouts.md#41-合法文章集合例外366)。
本轮没有实现 ADR 0026 的 moderation/report/admin，也没有解除其发布门禁。

### 不作过度承诺

- full 持久层读取仍可能 materialize 一页；保留 full 结果、JSON 字符串和对象树需要额外内存。
  SQLite 每次仍读取一个完整正文，slab flatten 也有一个紧凑副本。
- admission 是单进程 handler 上限，不是全局流量保证、全页原始内存 reservation 或 RSS 硬上限。
- checkpoint 是协作式期限，不是同步 getter/CPU 的抢占；默认读取期限不包括先前 queue wait，输出期限另计。
- native finish/accepted bytes 不是对端已消费全部内容；writer duration 不包括先前 DB 获取。
- 取消、deadline、关闭 socket 都不是未知数据库工作已经停止的证据；不能用超时制造替代容量。

## 3. 独立有效新增行：802

不是 Git 增量，也不计历史交付。主路径的 **1013 个候选运行行扣除 211 行**，得到 **802 行新增生产功能**。
第二条独立实现确认 **802/802，0 个失败**。这是两条程序路径及显式语义账本的复核，
不冒称存在另一位独立人工审阅者。

- [主计算器](article-collection-lines.ts)：固定基线的实际 Git 新增行，Babel AST/token 排除 imports、types、
  注释、空白/标点、re-export、未初始化 class fields 与静态 JSX；全基线生产片段和本轮片段去重。
- [逐片段语义排除](article-collection-line-exclusions.json)：固定行号与原文，额外排除 OpenAPI 静态契约、
  默认设置、静态 metrics 说明、SQL/serializer/路由接线、既有阅读/诗行算法、类型别名与未初始化绑定、
  拆行/改名/历史 runtime 重复。测试、docs、配置、生成物、自动化脚本和 UI 展示不贡献额度。
- [独立验证器](verify-article-collection-lines.ts)：Node 24 原生 TS 擦除、现有 ESLint 的 Espree JS tokenizer，
  再验证 source SHA-256、Git 新增位置、擦除后的历史和本轮运行片段去重，独立固定基线及最低 800。
- [逐文件/逐行证书](article-collection-lines.json) 和 [独立运行确认](article-collection-runtime-check.json)
  保存准确 hashes。早期宽松候选曾高于 800，但严格独立复核只有 758；未当作达标。
  后续补的是实际复现的读取期限、并发失败物理所有权及取消清理缺口，不是补注释或恢复历史代码。

复核命令（临时输出放在 Git 忽略的验证目录）：

```sh
node docs/audit/article-collection-lines.ts > verification/collection-boundary/recomputed-lines.json
cmp docs/audit/article-collection-lines.json verification/collection-boundary/recomputed-lines.json
node docs/audit/verify-article-collection-lines.ts
```

基线后的生产源文件有任何修改都必须重新计数。Node type-erasure 的 experimental warning 不代表检查失败。
没有引入新的项目依赖；验证器复用 frozen 工具链中已有的两个 parser。

## 4. 实际 Red → Green 与最终本地验证

原始反例是实际 `serializeRestArticles` 序列化的三篇合法作品，共 **8,538,151 bytes**；
每篇 19 个 `code` block、各 49,900 个 CJK 字符，经过真实 domain validator，不是降低内容限额的 mock。

| 行为 | 已执行的 Red | 已执行的 Green |
| --- | --- | --- |
| 合法大全文列表/三 locale/不回退 fixtures | 4 项全部失败 `too-large` | 根套件内回归通过；真实 SQLite/PG HTTP 和浏览器通过 |
| owned bytes / 巨型 chunk / strict EOF | Buffer 复用、巨型一次 enqueue 分别失败 | 最新 collection JSON/lifecycle 18/18，通过且无跳过 |
| writer drain、同步超期、UTF-8 fence | 2 fail / 1 cancelled（7 项中） | writer 7/7；加 budget/OpenAPI/docs 的集中验证 25/25 |
| 原生集合 admission | 2/2 fail（应 503 实为 200） | 初始 2/2 后追加 shutdown/settings；最新 4/4 全通过 |
| 原生读取期限 | 2/2 fail（客户端等不到响应；无效配置未拒绝） | 固定私有 504、迟到 DB 不启动 metadata、card abort 均通过 |
| 并发 metadata 物理所有权 | 实际 `{status:500, active:0}`，另一个查询仍阻塞 | `{status:504, active:1}`，只有全部真实 settle 才归零 |
| 取消 decoder 清理 | 缺少 abort 协议导致失败 | EOF 前取消保持失败、清理只一次且不改取消 receipt，通过 |

最新完整生产代码上的实际本地结果：

| 命令/范围 | pass | fail | skip | 说明 |
| --- | ---: | ---: | ---: | --- |
| `pnpm test` | 2373 | 0 | 450 | 总 2823；未注入真实 PG 的分支明确跳过，不冒充通过 |
| `TEST_DATABASE_URL=… pnpm --filter @bot-thk/api test:integration` | 743 | 0 | 0 | 实际本地 PostgreSQL 17.11，含双 Web、HTTP、cursor 与 provider contracts |
| `pnpm test:web` | 279 | 0 | 18 | 先构建 production bundle；18 个 PG 分支由上行真实集成覆盖 |
| 本轮 Chromium 大集合专项，`retries=0` | 1 | 0 | 0 | 实际 API→BFF→浏览器 >8 MiB，最终正文、SSR poetry/length、详情 TOC/朗读、英文归档和 sitemap |
| 读取期限/ownership/serializer/writer 集中验证 | 31 | 0 | 0 | 包含同步过期、嵌套 sibling、throw undefined、迟到错误不破坏 end、三批查询仍批量 |

`pnpm typecheck`、`pnpm lint`、现有 scoped `pnpm format:check`、`pnpm openapi:check`、
`pnpm test:routes` 均 exit 0。真实无邮件 `verify:publish --json` 的 `failed=0`，
证明写作台发布后 API 列表与 Web SSR 可见。format 命令范围仍是既有三文件，不能宣称全仓格式化。

完整浏览器分片、Docker 镜像/portable stack/`test:all`、CodeQL 和 required gate **未在本沙箱全跑**：
此处没有 Docker，Chromium 使用单独 provision 的本地 runtime；以上只声明实际运行的专项。
这些由本轮提交的 GitHub CI 提供最终证据，不能使用旧 PR #365 的 CI 替代。

## 5. 依赖、冲突及交付边界

- 没有增加/升级项目依赖，`pnpm-lock.yaml` 无差异。早期 `pnpm audit --audit-level high` 曾 exit 0，
  当时只有一个已有 low 等级 Babel advisory；这不是最终审计结果。创建 PR 后重跑已变为 **exit 1，2 high + 1 low**，
  详见下节和 [#368](https://github.com/BrainEno/no-wave/issues/368)。临时 PG、Chromium 和审计工具只在忽略目录。
- 检索过公共模块索引、既有 `upstream*.ts` / `StreamingJsonValidator`、body reader、API serializer、
  读取/SQL ports、生命周期和设置模块。collection framer 复用 syntax validator，新增的是 envelope/item
  边界及逐项投影；owned slabs 解决字节所有权；API 读取期限保护的是 native read 阶段，
  不从 Web 包导入服务端资源策略。`settledReads` 补齐 Promise.all 的提前失败与真实物理完成差异。
- 当前分支只以指定基线为本轮计数起点；本轮没有计入 PR 363/365 或其他历史功能，
  没有重算 continue_tags，没有数据库 migration、部署别名清理或生产数据变更。
- 合并冲突、最终 head 的 checks 和 issue 关闭动作在 PR 审查记录中据实更新；
  即使 CI 通过并按授权关闭已解决 issue，也不表示已经合并或部署。
- 已复核改动范围与测试资料；未发现真实凭据、真实用户数据或无关变更进入补丁。

## 6. 远端验收与未解除的依赖门禁

本节的第一轮远端证据绑定生产代码提交 `5b7967e79877638d3c21c905a69aa39c992039d9`，
[PR #367](https://github.com/BrainEno/no-wave/pull/367) 的
[CI run 44280062098](https://github.com/BrainEno/no-wave/actions/runs/44280062098) 和
[CodeQL run 44280062156](https://github.com/BrainEno/no-wave/actions/runs/44280062156)。
后续若只有文档更新，最终 head 的实际 checks 仍以 PR 检查记录为准，不能用本节旧 head 的通过替代。

| 第一轮远端检查 | 实际结果 |
| --- | --- |
| PostgreSQL integration、Web production build/behavior | 通过 |
| local-dev-chain（SQLite / PostgreSQL） | 两项通过 |
| portable-stack（SQLite / PostgreSQL） | 两项通过 |
| Chromium e2e 分片 1 / 2 / 3 / 4 | 四项通过；check annotations 分别报告 60 / 67 / 61 / 52 passed |
| container-image、performance-baseline | 通过 |
| CodeQL（分析及结果检查） | 通过 |
| full-local-suite | **通过**；实际执行隔离的 root / Web / 自有 PostgreSQL / 四个浏览器分片 |
| verify | **失败**，安装成功后依赖审计失败；后续测试/lint/format/typecheck/build/route/publish 步骤被跳过 |
| required-checks | **失败**，没有被其他通过的检查掩盖 |

第一轮共 17 项检查：**15 success / 2 failure / 0 pending**；两项 failure 是 verify 和汇总 gate，
不能报告为“CI 全绿”。文档、发现、inventory 与 CI-policy 的最后专项复核为 **38 pass / 0 fail / 0 skip**。

### 不是网络错误，也不能以开发依赖为由豁免

本地同一 lockfile 重跑 `pnpm audit --audit-level high --json` 返回 exit 1：
两个 high 来自公开的 [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)，
另有一个既存 low。`pnpm --recursive why picomatch` 确认路径为既有开发工具链：

- `stylelint@17.4.0` / `fast-glob` / `globby` → `micromatch@4.0.8` → `picomatch@2.3.2`；
- `@react-router/dev@8.5.1` / `vite@8.3.6` / `tinyglobby@0.2.17` → `picomatch@4.0.7`。

查询时 npm 的 `picomatch` latest 仍是 `4.0.7`，advisory 将 `<=4.0.7` 列为受影响范围，
`first_patched_version` 为 null。没有可直接升级的官方已发布修复版；不伪造版本、忽略 advisory、
缩小到 `--prod`、降低 severity 或放宽 required gate。[#368](https://github.com/BrainEno/no-wave/issues/368)
单独跟踪上游修复或需完整兼容性验证的替代方案，这不算本轮新增生产功能。

因此，本轮代码与可执行验证已提交，但 **required CI 验收未完成**。
#366 / #356 / #353 暂不关闭，以免把尚未合并且受 gate 阻塞的实现误报成正式解决。
没有合并、部署、生产数据操作或依赖审计豁免。
