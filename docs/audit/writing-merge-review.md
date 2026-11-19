# 本机三方文稿合并：范围、回归与本轮独立有效行验收

固定增量基线 **`b7009ebfaa160525d4047b81316d8ba4e8709487`**，唯一工作分支
`arena/4c7ee59b-no-wave`。owner 在说明丢稿/错误基线、未加密本机文件与内存边界后，
明确批准 `approve-local-three-way-full`。风险中高，边界见
[ADR 0046](../architecture/decisions/0046-local-three-way-writing-merge.md)与
[操作说明](../operations/writing-merge.md)。上一轮恢复功能的 807 行不计入本轮。

本页记录功能边界、开发过程留痕与可重现审计。**最终精确提交、全部本地/CI/CodeQL
结果和 Ready/ordinary merge 事实以 [PR #376 的验收记录](https://github.com/BrainEno/no-wave/pull/376)
为准**；不把下面的开发子集、旧提交或环境不可用当作最终全量通过。没有生产部署授权。

## 行为、最小边界与复用

- Given 三份已明确选择的单篇备份，When 作者确认共同基线并分析，Then 严格检查全部
  UTF-8/JSON/节点/URL/容量，按精确内容区间给出建议；重复或顺序歧义保留整篇冲突。
- Given 重叠修改、删除/修改或同位置插入，Then 不猜作者意图，逐项选择后才允许准备结果。
  筛选、12 项分页和焦点定位只是视图，不改变隐藏的人工取舍。
- Given 分析或取舍已变化，When 迟到读取/摘要/计划/准备完成，Then 不覆盖新意图、复活
  私密 DOM 或交付旧下载；改来改去也使旧 revision 失效。
- Given 手动导出/重新读取决策计划，Then 不含正文和文件名，来源角色/摘要/时间严格绑定；
  预览完整替换影响，另行确认才应用，绝不自动写编辑区、缓存或服务器。
- Given 已完成取舍，When 生成新备份，Then 独立消费三份来源的完整顺序，序列化后逐项
  核对真实选择，重新执行完整既有备份合同；组合超限整份拒绝，不截断或部分成功。
- Given 结果已准备，When 作者展开影响核对，Then 逐来源比较完整正文、根属性、四个字段，
  列出未采用分支改动、覆盖无冲突建议、零块取舍与回到基线；不把候选未选等同于文字丢失。
- Given pagehide、历史缓存返回或卸载，Then 清除本页内存/对象 URL，不自动重读本机文件。

已检索共享索引、`writing-session`/`writing-backup`/`writing-compare`/`writing-document`、
collection 模型/控制器/浏览器 helper、现有路由/SSR/cache/bundle 和写作恢复调用/测试。
复用严格备份解析/序列化、collection 重复键扫描/确定性 JSON/SHA-256、完整 fatal UTF-8
文件读取、`CollectionDownloadLease`、`bindCollectionPrivacy`、字素安全片段和文稿检查。
仅将既有 canonical helper 导出/命名，原算法及 collection 摘要合同不变，零计入行数。
展示型两稿比较的启发式 changed/moved 配对和未保存 key 的规范化语义不适合作为无损三方
编辑指令；新增算法仅承担共同基线区间/闭集取舍。没有新依赖、API/BFF、schema、权限、
生产环境配置、自动缓存、上传、媒体请求、发布或请求重放。

主要生产文件：`packages/web-ui/src/lib/writing-merge*`，authoring 下五个
`writing-merge-*.tsx` 组件，以及薄 `/write/merge` 页面、三处导航与响应式 CSS。
完整性、结构诊断与取舍影响只读且有界，不引入另一套编辑器、富文本合同或下载协议。

## 回归先行与发现的问题

- 来源/对齐、闭集计划、控制器和独立守恒分别保留 RED → GREEN 日志。独立守恒测试会
  主动删除/重复/乱序区间、改写格式/字段/根属性/输出，不能只验证同一算法的计数。
- 控制器首版迟到取消异常会把新取消状态改回 idle；用当前 abort 身份保护 catch。
  同步订阅者在 running 发布时取消又曾被后续设置覆盖，先建立 fence 再发布运行状态，
  保留回归测试。换来源、确认撤回、选择 ABA、计划读取/导出均有独立迟到完成用例。
- 集成新守恒模块时一次并行编辑丢了 import 和 coverage 类型，聚合出现 9 pass/34 fail；
  顺序恢复并完整复跑，不删除日志或放宽断言，后续 45/45 通过。
- 初次完整根测试是 3146 项、2680 pass/1 fail/465 skip：失败明确来自新增文档引用的
  本审阅文件尚未创建，不是产品运行断言。已补齐文件；后续全量重跑单独记录在 PR，
  不把这一次失败记绿。
- 严格语义初审剔除 422 行签名/默认状态/DTO/薄接线后旧范围只有约 752 行，未达 800；
  没有放宽排除或重复计数。补齐有实际价值的“未采用改动/来源完整对照”，先测试陈旧输出、
  下载文本与预览不符、零块取舍、格式/根属性与歧义，再接入只读结果面板。
- 影响检查首个 fixture 使用既有合同不允许的 rtl，在实现前即正确被拒；改为允许的 ltr
  根属性差异后四项均在拒绝 scaffold 上 RED，再真实实现 GREEN，未放松生产合同。
- 影响面板的新增浏览器断言曾在未确认未加密风险前期望下载按钮可用，10 pass/1 fail。
  生产拦截正确；测试现在先断言 disabled、明确勾选，再验证筛选不撤销取舍和可用下载，
  保留全部原断言，相关 11 项重新通过，手机 axe 也展开影响候选。
- 完整四分片首次第 1 分片 70 项通过，但新文件改变了文件级分片，旧通知同步用例在
  第 2 分片耗尽共享临时栈的 80 次注册预算，真实返回 429。终止不可恢复的该次运行，
  后续分片未执行，不把局部结果当全套。仅把 `notification-sync.spec.ts` 改用既有
  `article-view-stack` 每用例私有真实 SQLite/API/Web（仍继承 CSP 审计）；不改断言、
  请求语义、生产/fixture 限额或分片配置。该文件独立 12/12 通过后，再从完整入口重新验收。
- 浏览器使用真实本机文件输入与下载：匿名/离线、私密字串不持久化/不上传、链接和图片
  不请求、坏 UTF-8、转义重复字段、超限 admission、晚到原生 FileReader、计划预览不自动
  应用、换来源/选择撤销结果、重复块、分页/焦点、手机/axe、pagehide/bfcache 与组合超限。

## 本地验证口径

工具链 Node 24.22.3 / pnpm 10.20.0；证据日志留在忽略的
`verification/writing-merge/`，不提交截图、大日志、运行依赖或数据库。子集重叠不相加。

- 开发期间 frozen install、生产 build、完整 lint/typecheck 及字体离线/配方检查已实跑通过。
  字体仍 2887 faces / 35076184 bytes，本轮无需重新生成，也未修改字体来源/配方或二进制。
- 增加影响面板后的七模型子集 49/49；生产 Web 开发快照 300 项、282 pass/0 fail/18 skip；
  相关浏览器 11/11；路由/匿名空壳、无 mail 的真实临时栈 publish/匿名 SSR、28 项文档索引
  均有独立通过记录。它们有重叠，不相加；全量根/浏览器最终数字及冻结源码在 PR 验收表。
- 本机 `pnpm test:all` 确实在 Docker 预检 `spawn docker ENOENT` exit 1，没有执行其 Docker/PG
  聚合阶段。独立本地命令和 CI 不可包装成这个入口在本机成功。
- 本机浏览器是忽略目录中的 Chromium **153.0.8010.0** 适配，不是 Playwright 1.65.0
  官方期望的 Chromium 158/v1254。未增加关闭 CORS/CSP/同源隔离的参数，不改版本化配置
  或生产限流。完整 `pnpm test:e2e` 即使本机通过，也只能说明适配浏览器结果；官方浏览器、
  Docker/PostgreSQL 与容器门禁须由本 PR 精确源码 CI 独立验证。
- 依赖严格 audit JSON exit 1：1 low（开发依赖 `@babel/core` 的
  [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8)），0 moderate/high/critical；
  high 阈值 exit 0，不声称零漏洞，不顺带升级无关编译工具链。
- 当前 code-scanning 全告警清单与 main 分支保护 API 均返回 403，不能声称完整告警库存或
  保护配置已审阅。最终 workflow/job/step/check/annotation/review/blocker 直接从 GitHub
  可读接口核对，不用 CodeQL 成功冒充零告警，也不虚构不可读日志里的 PostgreSQL 精确数量。

## 独立有效行审计

固定基线下 **1299 候选 − 489 显式扣除 = 810 行有效新增生产功能代码**。
[主证书](writing-merge-lines.json)绑定逐文件 SHA-256/精确新增行；
[语义 ledger](writing-merge-line-exclusions.json)逐片段说明扣除理由；
[独立运行 token 复核](writing-merge-runtime-check.json)为
`claimed=810`、`runtimeConfirmed=810`、`failures=[]`、`satisfied=true`。
主证书 SHA-256 为 `2553f839ae59c8dc2df0c039b1a82cdcf92c3217be6aadc0484ea23fabb71110`。
复核初次额外否决 22 个历史/重复运行片段，已经全部扣除，未放宽复核规则。
两份审计脚本的独立严格 tsc 也已通过。

| 不重叠生产模块 | 有效新增行 |
| --- | ---: |
| 精确三方对齐、选择验证、完整输出重建 `writing-merge.ts` | 180 |
| 来源流与序列化输出守恒 `writing-merge-integrity.ts` | 75 |
| 取消/来源世代/取舍 revision 和计划/结果下载见证 controller | 129 |
| 严格闭集、来源绑定、无正文的手动计划 | 49 |
| 全局筛选/分页/冲突定位/计划替换/结果账目 review helper | 63 |
| 有界只读结构路径诊断 | 51 |
| 实际下载文本与预览、未采用改动和逐来源精确对照 impact helper | 46 |
| 五个组件的动态取舍/诊断/结果/计划行为（已扣薄接线） | 217 |
| **合计** | **810** |

开发期间 main 合入 #374 的 ADR 实施状态索引变更，已在同一工作分支同步
`1e0e86b177423d1c9f8b05c0091bb8e93f392726`，保留其新索引/门禁说明，新增 0046 行和
Implementation 记录。同步来的主线工作全部零计入本轮；固定增量审计基线没有改变。

执行方式：

```sh
node docs/audit/writing-merge-lines.ts > docs/audit/writing-merge-lines.json
node docs/audit/verify-writing-merge-lines.ts > docs/audit/writing-merge-runtime-check.json
```

只允许新 merge 生产模块的真实 Git 增量；AST/tokens 排除类型、注释、imports、静态 JSX，
对全基线生产 TS/TSX 和本轮新片段去重。逐片段语义排除签名、空状态/协议/文案、结果 DTO、
简单 props/事件/实例化/订阅接线；导航、CSS、路由胶水、helper 导出零计数。
独立 Node 24 type erasure / esbuild+source map / Espree 路径只否决已有 claim，不能补数。
测试、文档、工具脚本、依赖、生成资源、搬移/重命名及历史工作一律不计数。

## 安全与剩余门禁

下载未加密，错误基线/人工选择可能遗漏内容；摘要不是作者签名或服务器保存回执。
同源脚本/XSS、扩展、共用设备、浏览器进程内存/交换区/已下载文件不是本页可安全擦除的边界。
远程图片同意、媒体所有权、停用类型/历史语言、原 revision/expected actor、未知请求精确重试
和既有恢复账号隔离规则保持不变。没有真实用户稿、凭据、生产数据或无关功能变化。

Ready 前必须检查本分支精确 head/base、独立 push/PR CI 与 CodeQL、步骤/注解/retry、审阅和
blocker，先显式 Ready 再普通精确 head merge，不用 auto/admin/bypass。#331 和 ADR
0026/0041–0043 的真实主机、跨主机、通知到人、密钥、备份/回滚与部署资格继续独立开放。
