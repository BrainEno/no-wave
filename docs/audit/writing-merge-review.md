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
  本审阅文件尚未创建，不是产品运行断言。已补齐文件，后续完整重跑为 3152 项、
  2687 pass/0 fail/465 skip；不把初次失败记绿。最终精确源码验收仍单独记录在 PR。
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
  请求语义、生产/fixture 限额或分片配置。该文件独立 12/12 通过，随后正式入口完整
  四分片分别 70/75/59/62，共 266 项通过、零失败；不把独立子集重复相加。
- 进一步核对发现 CodeQL workflow 成功，但独立 CodeQL check 对测试中的 URL 子串
  断言给出 failure，并留下未解决审阅线程；workflow 绿不能代表安全检查全绿。这不是生产
  URL 放行逻辑，仍将测试加强为整个结果正文与选定来源树 `deepEqual`，同时检查根属性。
  忽略目录中仅篡改测试结果 URL 为“其他主机 + 原地址查询值”的突变：旧断言漏检通过，
  新断言以预期 exit 1 拒绝同一突变；未篡改的七模型重新 49/49。不添加抑制、放宽查询
  或忽略线程；最终新 head 的独立 checks、注解和线程状态在 PR 再确认。
- 主线随后合入 #375（`f1bf85e55c5081d2b2b1a1e15f8bf36a7f49cb1a`）移除生成 WOFF2。
  主线 CI `44543108433` 与本 PR 合并测试均实际失败：多个干净检出入口缺少字体，Docker
  未复制生成脚本。在当前分支同步，保留“不跟踪生成物”，不重新提交字体或退回该决定。
  最小修复是根测试与 Web dev/build 共用 `fonts:prepare`、Docker 仅构建阶段带生成器和
  验证依赖；严格 check 对缺失仍失败，prepare 只容忍缺失生成文件，不掩盖坏字节、未知
  文件、许可证、CSS 或配方漂移。冷重建必须逐字节复现既有 manifest/CSS，发布前再核对
  输入，不把构建变成自动元数据升级。构建自动化不计入本轮 810 行。
- 字体构建回归先 RED：19 pass/6 fail（5 个新增行为及实际缺失资产），实现后 25/25。
  首次冷下载因本机 Node 未信任系统 CA 失败，保留日志；仅本机启用 `--use-system-ca`，
  保持 TLS 校验，重新从固定 SHA/blob 来源生成 2887 faces / 35076184 bytes。manifest、
  CSS、许可证无内容变化，WOFF2 与 staging 保持忽略；强制 fetch 失败的暖准备仍通过，
  确认完整产物只离线核验。没有新增字体来源、配方、依赖或前端外发行为。
- 首次字体集成修复仍遗漏了直接 React Router CLI 的 portable/perf/dev 路径，以及
  `test:all`/独立库存守卫对新根命令组合的识别；`11ee9599` 的 push/PR CI 均真实失败，
  不用重试掩盖。现在 Vite 初始化先 await 同一原生 Node 准备命令；不依赖全局 pnpm。
  全套入口用干净环境显式准备，只把唯一已审前缀映射为原来的闭集库存，其他 shell/环境
  组合仍拒绝；独立库存守卫继续独立遍历，不排除或减少实际测试。准备/根/Web 任一失败
  均不能创建数据库，原隔离、清理、退出码和双 reporter 断言全部保留并扩充。
- 原生 CLI 在无生成资产、无全局 pnpm 的真实冷构建先 RED（缺少同一 WOFF2），加入
  初始化前置后 GREEN：固定来源重建 2887 faces 并完成生产构建，收据未变。编排与字体
  子集先 36 pass/5 fail，独立库存另有 RED；修复后连同模型/库存/reporter 共 95/95，
  完整 strict typecheck 和相关 lint 通过。异步 config 的回调显式保留 string 类型，
  未关闭 noImplicitAny 或减少检查。所有构建自动化及其回归仍零计入 810 行。
- `b6df6d0c` 的两套性能基线均成功，PR 四浏览器分片与 PostgreSQL job 成功，但
  portable push 作业的可读注解明确记录固定 Git blob 下载 HTTP 403；其他通用构建
  退出码不冒充同一根因。新增构建期固定 revision/raw 路径传输，仍是原九份公开
  字体/许可证、原 blob 与 SHA-256；不引入 GitHub token、外部配置或运行时环境白名单。
  只有连接失败/有限可用性状态可退回原 API 一次；两条路径都禁止重定向、限制期限及
  流式字节，坏字节/身份/JSON/404 不降级。先 7/7 RED，后全部 GREEN；本机 raw
  网络不可达，实际经原固定 API 重新下载九份字节并与原认证缓存逐一相同，raw 真实
  网络路径的验收留给最终精确源码 CI，不把 mocked 403 用例称为外网成功。
- 同时本机真正移开全部 2887 个忽略生成文件，复现 dev 冷子集化耗尽服务就绪窗口：
  **91028ms / exit 1**、原始 `within 90s` 错误。准备移到服务启动前，使用当前 Node、
  supervisor abort 信号与 300s 构建期限，API-only 不执行；服务原 90s 门槛未变。
  同样无生成文件的 GREEN 实跑 **214413ms / exit 0**，真实 API/worker/Web、写入探针
  和有界关停通过，随后相关模型/库存/reporter/字体/传输共 **103/103**，严格 scripts
  tsc 与相关 lint 通过。还重建一次 2887 faces 并完成原生生产构建，manifest/CSS/OFL
  未改。检索字体生成器、共享 font-assets、web-build-cli、dev-supervisor 及调用/测试；
  构建期匿名固定输入不同于带业务身份/预算的 web-http，后者不引入构建器复用。
- `b6df6d0c` 本机完整根测试 3159 项：2693 pass/1 fail/465 skip，唯一失败是既有
  sitemap fixture 的 40ms 上游期限；原测试不改门槛重跑 18/18。`34a2ac7c` 全量再次
  3167 项：2701 pass/1 fail/465 skip，同一首个投影约 45ms；两次都不算全套通过。
  根因是成功 fixture 在客户端期限启动后才构造首个 Node `Response`。最小测试修复
  先准备静态服务器响应，每次调用仍 clone 全新 body；40ms 没变，生产 transport、
  20ms 连接/流挂起与取消/体积负例均未改。忽略目录注入首个构造 80ms 的同一见证：
  改前预期 timeout RED，改后 GREEN，完整 sitemap 18/18；再把忽略副本的 20ms 改成
  2500ms，原连接/流两项被 1500ms test timeout 拒绝、进程 exit 1。没有给通过路径
  加重试、关闭计时器或放宽断言；最终仍跑未经预热/注入的正式完整入口。
- 浏览器使用真实本机文件输入与下载：匿名/离线、私密字串不持久化/不上传、链接和图片
  不请求、坏 UTF-8、转义重复字段、超限 admission、晚到原生 FileReader、计划预览不自动
  应用、换来源/选择撤销结果、重复块、分页/焦点、手机/axe、pagehide/bfcache 与组合超限。

## 本地验证口径

工具链 Node 24.22.3 / pnpm 10.20.0；证据日志留在忽略的
`verification/writing-merge/`，不提交截图、大日志、运行依赖或数据库。临时工作区重建后，
忽略目录中的旧日志/浏览器不保证保留；本页历史事实不等于最终源码验收，最终重跑和
可读云端注解在 PR 留痕。子集重叠不相加。

- 开发期间 frozen install、生产 build、完整 lint/typecheck 及字体离线/配方检查已实跑通过。
  同步 #375 后再实跑冷生成和离线准备，字体仍 2887 faces / 35076184 bytes；来源/配方、
  manifest/CSS/许可证未改，生成 WOFF2 不入 Git。
- 同步 #375 前，七模型子集 49/49；完整根测试 3152 项、2687 pass/0 fail/465 skip；生产 Web
  重新 build 和 300 项行为测试为 282 pass/0 fail/18 skip；正式浏览器入口四分片 266/266。
  路由/匿名空壳、无 mail 的真实临时栈 publish/匿名 SSR、28 项文档索引也有独立通过记录。
  全套和子集有重叠，不相加；最终精确源码和后续测试加强后的重跑结果在 PR 验收表。
- 本机 `pnpm test:all` 确实在 Docker 预检 `spawn docker ENOENT` exit 1，没有执行其 Docker/PG
  聚合阶段。独立本地命令和 CI 不可包装成这个入口在本机成功。
- 早先完整本机浏览器使用忽略目录中的 Chromium **153.0.8010.0** 适配，不是
  Playwright 1.65.0 官方期望的 Chromium 158/v1254，未关闭 CORS/CSP/同源隔离或提高
  限流。工作区重建后该适配不在，官方 executable 也实际不存在；不为取得绿色伪造
  浏览器或把 `--list` 的 266 项库存当执行通过。最终官方浏览器、Docker/PostgreSQL 和
  容器门禁由本 PR 精确源码的完整 CI 独立验证，本机环境缺口另行说明。
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

| 不重叠生产模块                                               | 有效新增行 |
| ------------------------------------------------------------ | ---------: |
| 精确三方对齐、选择验证、完整输出重建 `writing-merge.ts`      |        180 |
| 来源流与序列化输出守恒 `writing-merge-integrity.ts`          |         75 |
| 取消/来源世代/取舍 revision 和计划/结果下载见证 controller   |        129 |
| 严格闭集、来源绑定、无正文的手动计划                         |         49 |
| 全局筛选/分页/冲突定位/计划替换/结果账目 review helper       |         63 |
| 有界只读结构路径诊断                                         |         51 |
| 实际下载文本与预览、未采用改动和逐来源精确对照 impact helper |         46 |
| 五个组件的动态取舍/诊断/结果/计划行为（已扣薄接线）          |        217 |
| **合计**                                                     |    **810** |

开发期间 main 合入 #374 的 ADR 实施状态索引变更，已在同一工作分支同步
`1e0e86b177423d1c9f8b05c0091bb8e93f392726`，保留其新索引/门禁说明，新增 0046 行和
Implementation 记录；随后再同步 #375 的 `f1bf85e55c5081d2b2b1a1e15f8bf36a7f49cb1a`。
同步来的主线工作、字体构建集成修复及其回归全部零计入本轮；固定增量审计基线没有改变。

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
