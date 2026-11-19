# 可选本机文稿恢复：本轮范围、回归与独立有效行验收

固定增量基线 **`c3171b1f13428605c1a5bbf2386071a383b21089`**，工作分支
`arena/25e705a4-no-wave`。这不是上一轮告警审阅的行数延用。
owner 在得知未加密、同源/共用设备、容量与退出清除的权衡后，明确批准
`approve-writing-recovery-full`。风险为高；决策见
[ADR 0045](../architecture/decisions/0045-default-off-local-writing-recovery.md)，
使用/故障说明见[本机恢复手册](../operations/writing-recovery.md)。

## 已实现的可观察行为与文件

| 范围                     | 行为                                                                                                                  | 主要文件（`packages/web-ui/src/` 下）                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 默认关闭、有界本机持久化 | 明确启用，20 份/16 MiB，UTF-8 admission，不静默淘汰；事务完成才报告成功                                               | `lib/writing-recovery-model.ts`、`writing-recovery-store.ts`                                          |
| 账号/跨标签隔离          | live actor + epoch/writer/serial/CAS；陈旧证明/旧标签不能复活；新账号不见旧稿                                         | `writing-recovery-store.ts`、`writing-recovery-controller.ts`                                         |
| 手动预览恢复/下载/删除   | 完整输入/基线/缓存 witness，异基线和图片单独同意；只复制字段，不改变服务器身份                                        | `writing-recovery-controller.ts`、`components/authoring/writing-recovery.tsx`                         |
| 文章 dispatch 和未知结果 | opt-in 的 durable checkpoint 必须先于 dispatch；精确结算，保留后续编辑；恢复未知稿先人工核对                          | `writing-recovery-controller.ts`、`components/authoring/article-editor.tsx`                           |
| 人工只读核对服务器       | 精确来源/语言、8 秒/2 MiB、有界流/UTF-8/diff、BigInt 修订；结果返回后重验 actor/witness，不合并/不更新基线/不解除拦截 | `writing-recovery-source.ts`、`writing-recovery-controller.ts`、`writing-recovery.tsx`                |
| 会话与页面生命周期       | 请求前后 purge、同步隐藏缓存 DOM、焦点/online/bfcache 重验；错误可见但不清当前输入                                    | `writing-recovery-boundary.ts`、`writing-recovery-lifecycle.ts`、auth 组件、`authoring-workspace.tsx` |

先检索 shared-module index、`writing-session`/`writing-backup`/`writing-compare`/
`writing-document`、`lexical-article-state`、`CollectionDownloadLease`、catalogue reader、
notification actor transport 及 shared HTTP deadline/limited-stream/retry-after；均复用。
新增模块专门实现以前不存在的本机持久化/恢复协调，不再写一套 REST 授权、富文本解析、
下载 Blob 或网络重试策略。没有新 API/BFF 路由、服务端 schema、权限、限流、后台任务或生产配置变化。

## 独立有效生产行数

```sh
node docs/audit/writing-recovery-lines.ts > docs/audit/writing-recovery-lines.json
node docs/audit/verify-writing-recovery-lines.ts > docs/audit/writing-recovery-runtime-check.json
```

固定基线下 **1146 候选 − 339 显式扣除 = 807 行有效新增生产功能代码**。
逐文件 source SHA-256/精确行号见[主证书](writing-recovery-lines.json)，
逐片段理由见[语义排除表](writing-recovery-line-exclusions.json)，
独立工具结果见[运行时复核证书](writing-recovery-runtime-check.json)：
`claimed=807`、`runtimeConfirmed=807`、`failures=[]`、`satisfied=true`。

| 不重叠生产模块                                       |  有效行 |
| ---------------------------------------------------- | ------: |
| ArticleEditor 的快照/应用保护、checkpoint 和响应策略 |      14 |
| 手动预览/字段选择/差异/容量/失效 UI 行为             |     141 |
| 会话两侧 purge 与 metadata-only 通知边界             |      40 |
| 账号、输入世代、保存 checkpoint、恢复与来源核对协调  |     261 |
| 页面隐藏/恢复与生命周期检查                          |      19 |
| 严格记录解析、基线和恢复同意策略                     |      82 |
| 有界只读来源读取及修订/等价/差异分类                 |      79 |
| IndexedDB 原子 fence、CAS、容量和失败边界            |     171 |
| **合计**                                             | **807** |

主审计用 Babel AST/tokens 和 Git 增量行，去除基线**所有生产 TS/TSX** 的规范化旧行、
重复新片段、imports/types/signatures、静态默认状态/配置/帮助文案、JSX 纯标签、简单
props/bridge/订阅接线等。auth、Workspace、WritingTools 的纯接线和 CSS 全部零计数。
测试、文档、审计脚本、fixture、生成产物、依赖/lock 和历史轮次从不计数。

复核脚本不复用主 AST：TS 用 Node 24 type erasure；TSX 用已冻结 Vite 的 esbuild
和原始 source map；再用 Espree 校验运行 token、源码哈希、Git 新增行并对全基线/新增
运行 token 片段再次去重。它只能否决已有 claim，不能补足行数；静态/接线语义仍由显式
ledger 负责。初次复核额外否决 25 片段，已全部扣除而非放宽复核。

## 回归先行与真实缺陷

- model/store/controller/boundary/lifecycle/source 均先建立失败行为，再实现/修复。
  失败日志和中间构建保存在忽略的 `verification/writing-recovery/`，不把大日志和浏览器
  截图提交；最终 CI/本地总数在 PR 正文/验收评论中记录，不把重叠子集相加。
- quota 在真实浏览器 `IDBObjectStore.put` 注入：旧稿保留、事务回滚、没有 checkpoint
  的文章请求计数为零；fake IndexedDB 另测 request success 后 abort、超时和 late-open。
- 两个真实标签保留独立 writer，旧 revision 不能覆盖/删除，新账号在无 UI 广播时也看不见
  旧稿；跨标签清除期间早先开始的 session 响应不能复活同意或文稿。
- 曾发现失败预览清空展示列表，后续 put 只合并内存会隐藏仍在盘上的其他分支；修为事务后
  重读完整列表并检查精确已存 revision，保留 RED→GREEN 回归。
- 曾发现离线清除不应要求成功身份网络请求，以及初始 opt-in 查询未完成前可越过 dispatch
  checkpoint；改为可离线尝试的 deliberate purge 和 entering barrier。
- 缺少安全随机 ID 曾使退出在清除前抛错；通知边界仍本地失效/尝试 purge，不伪造跨标签 ID，
  磁盘 fence 若生成失败则保留清除警告。关掉 pending open 必须拒绝其 promise 并关闭 late handle。
- 新增**真实退出竞态**先在浏览器复现：退出请求等待时，新标签启用并写一稿，旧实现退出后
  残留 1 份（期望 0）。共用 `runSessionChange` 在成功/失败请求两侧 purge；增加单元测试
  覆盖初次/最终删除失败的粘性警告，不让 finally 隐藏原请求错误。
- 来源核对测试覆盖完整 deadline（fetch/body）、坏 UTF-8/非 JSON/超额流/redirect 配置、
  手动 429 等待、bigint、不可读/未关联、等价并非回执，以及 HTTP 后缓存被改写/页面失效。
  浏览器用真实服务器更高 revision 验证只读差异，不更新编辑区/缓存基线且文章写请求为零。
  fixture 初次 PUT 因缺少合法 block ID 等 contract 字段被拒，修正 fixture，不放宽生产校验。
- 既有 writing-tools 的 logout 测试现在会有两个合法 alert；保留原“当前输入仍保留”断言，
  增加恢复面板失效断言，而非删除/模糊原行为验证。
- 完整浏览器回归发现新恢复监听器会在 pagehide 后被 online 提前唤醒；先补 RED，修为保留
  hidden fence，只有真实返回边界才恢复。关闭且 control 未变的被动检查只看 metadata，
  返回 actor=null/无 lease/无文稿；显式刷新、启用、control 变化或已启用缓存仍须 live actor。
  两个负例证明这个 off witness 不能在静默切账号后授权 opt-in，不能读取新增的私密文稿。
- 新增测试文件重新分片后，既有通知多账号用例耗尽共享栈 80 次注册预算；仅把两个通知
  actor spec 改用既有的每用例私有真实栈，保留全部 session 请求次数/隐私/无副作用断言，
  不提高生产或 fixture 限额，不放宽断言，不跳过测试。
- 首版精确源码 `03a641e` 的两套 CI 汇总均成功，但检查注解发现同一恢复用例依赖一次
  retry 才通过，因而保留 Draft，没有据此合并。浏览器 helper 重新预览只等已存在旧面板
  visible，可能在新预览的 actor/IDB 读取完成前变更来源；实际快照显示应用的是新预览
  读到的新稿。改为同时等待请求标题和旧预览过期提示消失，保留原冲突/输入断言；初次
  重复 10 轮 6 pass/4 fail，修后 **10/10、0 retry/skip**，失败记录不删除。
- 排查另用确定性单元 RED 复现真实反馈竞态：手动恢复正确拒绝旧 witness 后，独立后台
  put 成功会清掉冲突提示。控制器保留手动操作失败直到新显式操作或隐私边界；后台仍
  正常落盘并重读完整分支，不能把缓存成功冒充恢复成功。回归验证当前输入不变、两份
  分支完整、冲突提示保留，再显式预览才清除；新增后恢复单元 **44/44**。
- 登录页新增文案触发根字体配方检查 RED；使用既有固定来源/校验和的 `pnpm fonts:generate`
  同步派生字体、manifest 和 CSS，并运行 `fonts:check`。完整集合仍为 2887 faces、
  35076184 bytes，未变更字体来源或生成策略；所有派生资源零计入有效行数。

## 验证口径与剩余边界

本地工具链 Node 24.22.3 / pnpm 10.20.0；以下都是本轮实际执行，不延用之前轮次 CI。
子集有重叠，不能相加当作总数。

| 检查                                                                             | 本地实跑结果                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| frozen install、全仓 lint、根 format:check 与所有新增文件 Prettier               | 通过                                                                                             |
| 完整 pnpm typecheck（含 UI/API/Web/scripts/E2E）与两份新审计脚本的严格 tsc       | 通过                                                                                             |
| 生产 build、字体离线覆盖/配方、route smoke、无 mail 的真实 publish/匿名 SSR 探针 | 通过                                                                                             |
| 根 pnpm test                                                                     | **2636 pass / 0 fail / 465 skip**，3101 项；跳过的是需要外部临时 PostgreSQL 的用例               |
| 生产 Web suite                                                                   | **281 pass / 0 fail / 18 skip**；共享 PostgreSQL ledger/真实 PG 部分未在本机执行                 |
| 新增恢复单元子集                                                                 | **44/44，0 skip**；包含在根结果中                                                                |
| 完整浏览器清单中的直接相关覆盖                                                   | 恢复 14、原写作工具 17、通知 actor/恢复 9；包含在下行 255 中，不额外相加                         |
| **完整浏览器清单**，4 个独立临时 SQLite 栈                                       | **255/255，0 retry/skip**，分片 **70 + 63 + 60 + 62**；含字体预算、桌面/手机、CSP 和既有产品流程 |
| 依赖 audit --audit-level high                                                    | exit 0；**1 low，0 moderate/high/critical**；严格 audit --json 因此 exit 1，不称零漏洞           |
| 独立有效行复核                                                                   | **807/807，0 failures**，源码/证书哈希一致                                                       |

在完整浏览器、Web 和根测试并行时，未改动的 `upstream-release.test.ts` 的一个 10ms
用例曾出现 active=0（期望 1）；保留该失败日志，未改生产模块或断言。空闲环境单独
**10/10**，随后旧版完整根 **2635/0/465**；修复反馈竞态后的最终串行根为
**2636/0/465**。这不证明消除了该调度敏感性，仍须由本 PR 的独立 CI 再验证；
不把一次失败抹成“首次全绿”。精确提交的 CI/CodeQL 链接与最终
head/base/Ready/merge 事实记录在 PR 验收中。

修复后的本地完整回归曾在第一分片遇到未修改的 CSP inline-handler 用例缺少预期
violation 事件（0 而非 1，69 pass/1 fail）；未修改该安全用例、fixture 或生产策略，
独立真实栈连续 **10/10、0 retry**。失败日志保留，不把隔离成功当作消除了事件/时序
敏感性；之后串行重跑的完整结果以上表为准，云端仍须检查精确提交的失败/retry 注解。

`pnpm test:all` 确实在官方 Chromium 缺失预检处 exit 1，未运行其 Docker/PG 聚合阶段；
不能把上述独立浏览器分片的替代验证说成该官方入口已通过。
本沙箱没有 Docker/系统 PostgreSQL，官方 Playwright 下载位置也不可用；本地浏览器仅在
忽略目录里替换二进制/系统库位置，使用 Chromium 153，不附加下载包自带的关闭安全策略参数，
不改变版本化测试或生产限流。物理磁盘耗尽、断电、浏览器真实回收、多浏览器兼容和生产运维
未被模拟错误注入证明。官方完整入口、PostgreSQL 与容器检查仍须看本 PR 精确源码的 CI，
不能把本地环境限制记作成功。

唯一新增依赖是测试专用 `fake-indexeddb` 6.2.8（Apache-2.0、Node >=18）；它不进入运行
依赖或浏览器 bundle。既有开发依赖 `@babel/core` 7.28.5 仍有
[GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8) 的 low 告警，
本轮不顺带升级无关编译工具链。依赖审计结果以上表和 PR 为准，不用“CodeQL 成功”声称零告警。
首版 PR CodeQL 成功但因超过 300 个差异文件而警告无法取得完整 diff（955 个为字体派生文件）；
当前代码扫描告警清单/分支保护设置 API 返回 403，完整 Actions 日志的下载主机也超出沙箱
网络范围。CI 状态/步骤、浏览器结果及注解直接从 GitHub API 审阅；不编造日志内的 PG
精确用例总数，不把 diff 分级限制或不可读告警清单包装成无告警。
内容未加密、同源/共用浏览器及 XSS/扩展风险、约 600ms 最后编辑窗口和浏览器可回收性仍在。
请求字节/重试 key 永不持久化，缓存相同不能证明服务器写入结果；没有自动重放、修复或发布。
#331 以及 ADR 0026、0041–0043 的独立门禁不因本轮功能/merge 关闭。

提交前复核 diff、来源哈希与未跟踪文件；无真实用户稿、凭据、token、生产数据库或无关改动。
Ready 和 ordinary merge 只在 owner 已授权且本 PR 的完整 CI/CodeQL 与 head/base/blocker
重新核对后执行；不使用 auto/admin/bypass，不代表生产部署。
