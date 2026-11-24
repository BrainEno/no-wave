# 本轮审阅：本机术语一致性审阅

Status: archived

- 基线：`a46b927f56c74130177eb9659e4ae925bafd2f42`，分支 `arena/eadbc4c1-no-wave`。
- 范围：用户委托自主选择下一轮功能；本轮为多词表字面一致性、原文位置、拼写组合与只读人工审阅。
- 设计：[ADR 0049](../architecture/decisions/0049-read-only-local-writing-terms.md)；流程/限额：[操作说明](../operations/writing-terms.md)。
- 不把先前 PR 378 的功能、810 行、CI 或浏览器结果转为本轮信用。

## 前置审阅、复用与风险

读取根 AGENTS（无嵌套规则）、需求基线/测试策略/共享模块索引、collection/search/index/controller/browser、
`writing-document`、单稿替换、段落重叠、三方合并及调用者/测试，并核对开放 issue 清单。
已有单串查询、不重叠替换或完整段落候选均不提供多词表重叠主张与拼写组合；新算法不复制这些编辑权限。

复用严格备份/集合、`readCollectionJson`（含重复/危险键拒绝）、摘要、`inspectWriting` / `writingNodeAt`、
原生本机字节读取、惰性有界文字分页、`CollectionDownloadLease`、隐私过渡清理、整页导航和私有页头。
新 Aho–Corasick / 词表关系 / 原文跨度索引 / 拼写组合画像与既有单串检索和段落近似语义不同。
控制器保留两个显式输入的独立 fence，但不引入新的存储、请求、身份或媒体策略。

风险为本机敏感数据/并发/报告真实性，采用 test-first；无低风险展示代码的虚构 RED 声明。
不上传，不读外部文档，不写编辑区、原文件、服务器或恢复缓存；无依赖/锁文件/生成协议变更。

## RED → GREEN 与实际修正

1. 分析/词表占位实现的 7 个测试实际 RED，日志 `analysis-red.log`；实现后通过独立逐位置 Unicode oracle。
   最初一条手写重叠数量期望 16，独立 oracle 与逐长度组合均得 15（9 + 4 + 2）；修正错误期望，未改变匹配器迁就断言。
2. 分布、原文高亮和无明文报告的 4 个占位测试实际 RED（`review-red.log`），随后通过。
3. 嵌套可变 witness / 未知 coverage 字段的回归先出现 missing expected exception（`immutable-ledger-red.log`），
   关闭嵌套 schema、验证所有冻结边界后通过；不把浅冻结冒充不可变快照。
4. 控制器 7 个占位测试实际 RED（`controller-red.log`），首个用例还产生预期的未实现异步拒绝，不能算通过。
   完成两个读取 fence、取消、摘要/recipe/witness 检查和报告权限后全部通过；另补迟到摘要验收。
5. 导航测试在未登记新隔离页面前实际 RED（`navigation-red.log`），双向 Document 边界实现后通过。
6. 拼写画像 3 个占位模型实际 RED（`usage-red.log`），用原始 match/span-set oracle 逐格/逐文稿对核对后通过。
   同组折叠同形保留全部主张但按精确跨度计拼写类位置，未覆盖/无合格单元不被标记为完整缺席。
7. 冻结但虚构的关系分量/不可能计数先出现 missing expected exception（`graph-counter-red.log`）；
   增加独立图遍历和计数守恒检查后通过（`graph-counter-green.log`）。
8. 确定性生成 Unicode 语料对照所有主张，并逐个缩小三种扫描预算 1–20，独立核对每个结束位置完整前缀。
   原文邻居直接来自完整原文，oracle 不通过裁切字符串制造假的 word 边界。
9. 浏览器第一轮失败定位到标签名称混入选项或 textarea 值；增加稳定 aria-label，不用 `.first()` 绕过精确标签。
   第二轮请求监测误把**本站导航查询参数**中包含的域名当成外部请求，改为校验实际 URL hostname/path。
   后续 axe 真正发现横向滚动表格缺键盘入口；为滚动区域提供焦点、语义标签与焦点轮廓，未跳过 axe 规则。

原始日志在 ignored `verification/writing-terms/`，不提交浏览器、依赖、字体字节、日志、数据库或截图。

## 检查状态

以下结果均已检查实际输出；未运行和跳过不作通过。最终验收进程 `process-84c87fff` 已退出 0。

| 检查 | 结果 |
| --- | --- |
| 聚焦术语/导航 | **28/28 通过**，0 失败/跳过；25 个术语模型 + 3 个共享导航测试 |
| 全量 `pnpm typecheck` / `pnpm lint` / `pnpm build` | **全部退出 0**，真实生产构建，含脚本/E2E 类型与全量 CSS/TS/TSX lint |
| 完整根测试 | **3284 项 / 2819 通过 / 465 跳过 / 0 失败 / 0 取消**；不是把跳过数据库资格算成功 |
| 完整 Web | **304 项 / 286 通过 / 18 跳过 / 0 失败 / 0 取消**，包含新外壳/重定向/CSP；与构建串行 |
| `pnpm test:routes` | **退出 0**，含无账号/API 的新本机外壳和 URL 不选词表 |
| 兼容 Chromium 浏览器 | 修正后 **14/14 通过，50.0 秒，无重试**；含本轮 6 条及原 overlap 回归 8 条。此前 1/5、4/5、13/14 均不冒充通过 |
| 字体 / high 依赖门禁 | `pnpm fonts:check` **2887 faces，退出 0**；`pnpm audit --audit-level high` **退出 0，仍有 1 low**，不是零漏洞；依赖和锁文件不变 |
| 格式 | 官方 3 文件 `pnpm format:check` **退出 0**；另对全部新增 TS/TSX、审计工具/JSON 显式 Prettier 检查通过。E2E 格式曾失败，修正后复核；不宣称全仓库格式资格 |
| 审计工具 strict TypeScript、文档链接/ADR | 两份审计工具独立 strict TypeScript **退出 0**；ADR 索引/文档链接/本机开发文档 **30/30 通过**。ADR 的 Implementation 初次用了非闭集状态，门禁实际失败；改文档为 Done 后通过，未放宽测试 |
| 全部本机 `test:all` / Docker/PostgreSQL / 官方浏览器 | 本机没有 Docker；官方 Chromium 下载主机不在可用出网清单，本机未执行这些资格。兼容 Chromium 153.0.8010.0 来自 ignored npm 包，不能冒充 Playwright 1.65 官方 Chromium 158 |

本机 Node 24.22.3 / pnpm 10.20.0 已安装于 ignored `.local/`，frozen install 退出 0。
字体准备使用 Node 原生系统 CA，未关闭 TLS 检查。兼容浏览器不使用包提供的关闭 Web 安全参数；
浏览器旅程继续使用 enforcing CSP fixture，不登记违规豁免。合成隐私过渡和实际 goBack 均不是 BFCache 实际收纳证明。

## 远端门禁暴露的评论旅程隔离修正

初始提交 `d730112677087b63dff40f72848d7aa1600023f8` 的 push CI 中，
[e2e(1)](https://github.com/BrainEno/no-wave/actions/runs/44709346118/job/136196771197)
实际失败：既有 `comment-session.spec.ts` 创建测试作品首次和重试均收到 `429 RATE_LIMITED`。
该文件原先使用所有旅程共用的 API；生产 `article.create` 的真实 IP 预算为 30/小时。
这证明验收依赖其他旅程的配额状态；不声称已逐笔重建当时所有消耗请求，也不把该失败当作本轮全绿。

最小修正仅让此既有旅程复用 `article-view-stack` 的真实一次性 SQLite/API/Web 栈，
HTTP setup 显式使用 `readingStack.apiBaseUrl`，浏览器也使用同一栈。全部原评论/会话/CSP断言保留，
不提高生产限额、不伪造 IP、不 mock 响应、不增加重试或跳过用例；没有新增生产功能行信用。
修正后的评论旅程 + 6条术语旅程 **7/7 通过，23秒，无重试**，随后完整 typecheck/lint 和文档模型均退出0。
这些与此前14条是重叠集合，总共15条相关独立旅程，不能相加成21条。

初始提交两个未完成 CI workflow 已明确请求取消以避免继续消耗旧版本的 runner，取消不算通过。
PR379 保持 Draft，修正后精确HEAD的全部门禁仍须重新完成后才单独 Ready。

## 独立有效新增生产功能行

- [主审计](writing-terms-lines.ts)固定本轮 11 个新 lib 模块，不准入类型模型、UI、路由、导航、样式、入口登记、测试、文档或工具。
- 擦除 TS 类型/签名/import/标点，对**全部基线生产 TS/TSX**及本轮做去重，再用[逐行语义扣除表](writing-terms-line-exclusions.json)
  扣除 DTO/配置/静态文案/薄封装/重复策略。**整个控制器和报告模块候选均额外扣除**，不靠新命名的旧状态/投影模式补数。
- [独立复核](verify-writing-terms-lines.ts)使用 Node 24 TS 擦除、独立运行时 lexer 与全基线去重，检查 SHA-256、
  新文件身份和逐行扣除 pin；只能拒绝，不能补数。初稿 801 声明仅 775 独立确认，明确不合格；未降低 800 或恢复被拒信用。
- 最终[主报告](writing-terms-lines.json)：**1157 候选 − 354 进一步扣除 = 803**。
  [独立证书](writing-terms-lines-independent.json)：**803 声明 / 803 复核 / 0 拒绝**。两脚本均实际 `--enforce` 退出 0。
- 原 PR 378 的段落/解释/概览及任何历史实现均留在基线，不能再次计数。物理新增行数不是有效功能行。

复现（Node 24、frozen 依赖，不能忽略 cmp 退出码）：

```sh
mkdir -p verification/writing-terms
node docs/audit/writing-terms-lines.ts --enforce > verification/writing-terms/reproduced-lines.json
cmp docs/audit/writing-terms-lines.json verification/writing-terms/reproduced-lines.json
node docs/audit/verify-writing-terms-lines.ts --enforce > verification/writing-terms/reproduced-independent.json
cmp docs/audit/writing-terms-lines-independent.json verification/writing-terms/reproduced-independent.json
```

## 残余风险、变更范围与远端

使用中的正文/词表仍是内存明文；清引用不等于安全擦除，同源脚本/扩展/系统风险不消失。
报告无正文/词条明文，但分布、摘要、坐标仍敏感，可能猜测词条和长度；偏好词不是正确性证明。
证书 SHA-256：主报告 `8726229a9bf76b45f7881432108c05c5dba6a01aae62199cd326b12b8aa359b1`；
独立证书 `4aef387d88d3bcce88c55722c1b4bbaa0646694944f606efec44479d59c248e0`。
字面规则与有限预算不是语义一致性证明，所有未覆盖范围必须保留。

本轮不关闭 #317 的 type-aware Promise 缺口，不越过 #331 或 ADR 0026/0041–0043 的生产门禁。
无部署、账号配置、密钥轮换、自动修复或外部 Docs/Drive/Notion 访问。远端精确提交的 CI、Ready 和合并状态
必须另行观察，不能从本地记录推断。最终 diff 已复核：只含本轮术语审阅、必要入口/共享文字分页与对应测试/文档；无真实用户数据、秘密、依赖/锁文件或无关改动。
