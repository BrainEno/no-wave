# 本轮审阅：本机文稿重复段落审阅

- 基线：`82600adcaf66d7d4506aeba802bae3e0f5197424`。
- 分支：`arena/88508b31-no-wave`。
- 日期：2026-11-12；本记录区分实际通过、失败、跳过和不可用，不把基线 CI 当作当前变更证据。
- 任务：只读本机完整段落分组、有限近似候选、文稿对概览、按需片段解释、手动临时标记及无正文报告。
  设计与验收见 [ADR 0048](../architecture/decisions/0048-read-only-local-writing-overlap.md)，操作见[说明](../operations/writing-overlap.md)。

## 前置 review 与复用

核对根 AGENTS（无嵌套规则）、需求基线、测试策略、共享模块索引、backup/collection 校验与
index/search/controller/browser、`writing-document` 的提取/路径、`writing-compare` 的字形差异、
三方合并、密码文件、现有 UI/路由/单元/浏览器验收与开放 issue #284/#317/#331。

现有 `inspectWriting` 有单篇统计与重复标题；集合搜索需要已知字面查询；两稿/三方比较关心有序差异，
都不能替代跨所选文稿发现完整段落候选。本轮选择只读本机功能，而不是扩大到服务器写入或生产运维。

复用 `readCollectionFile`、`openWritingCollection`、`collectionCanonicalJson`、`inspectWriting`、
`writingNodeAt`、`writingTextDifference`、`paginate`、`CollectionDownloadLease`、
`bindCollectionPrivacy`、`requiresDocumentNavigation` 及 PRIVATE_PAGE_HEADERS。
没有用 `writingDraftKey` 作原文相等证据，没有把近似结果接入三方合并的保守对齐规则。

- 新倒排索引/完整片段集合评分不同于字面检索，不复制账号/API/存储策略。
- 文稿对概览对已列 finding 组合计数，避免展开位置对；近似组的两个文稿方向均保留。
- 按需解释重算当前两处的完整片段、频率、覆盖与唯一位置链，不发现新候选，不改变分数/报告。
- 新控制器只拥有一份明确本机来源及本轮临时状态；分析、解释、报告各有失效和取消边界。

## 行为优先与回归证据

1. 占位分析器先出现 9 个模型测试中的预期 RED，随后 9/9 GREEN。
2. 占位控制器先有 6 个断言失败、1 个等待真实校验的测试取消；实现真实读取/摘要/witness 后 7/7 GREEN。
   该 RED 的超时不是通过，最终无取消的测试。
3. NFKC 膨胀回归先出现“未按预算拒绝”的 RED，增加规范化总预算后通过。
4. 新路由 HTTP 验收在旧构建上实际返回 404，预期 200 的断言 RED；新生产构建后通过。
   缓存策略清单曾漏列新路由，完整 Web 检查据此失败；补入 PRIVATE_PAGES，不删除或放宽规则。
5. 片段解释占位函数的 5 个测试全部 RED；随后独立窗口 oracle 揭示测试预期的次数差一：
   `N` 代码点应有 `N - 5 + 1` 个窗口，15/25 代码点分别为 11/21，而不是 10/20。
   修正独立期望后通过；没有改变生产计数公式来迁就错误断言。
6. 解释控制器的 3 个新增测试先因缺少行为 RED，随后通过：覆盖旧结果忽略 AbortSignal、换位置、
   同值重跑、清理、来源/条件变化、同步清理阻止启动、结果 witness 不符拒绝；解释不撤销有效报告。
7. 文稿对占位的 4 个模型测试实际 RED，随后通过。独立全位置小语料 oracle 核对三种范围、
   相反近似方向、同篇组合、所有有效选择器与标记计数；400 处重复原文的 79800 个位置对
   仅产生 3 个概览单元，无位置对数组。旧分析对象即使值相同也不能复用旧概览。
8. 浏览器前几轮真实失败还暴露了精确标签、整页返回边界和相邻重复 React key；
   不使用 `.first()`、缩小断言或跳过失败场景。为控件提供明确标签，为解释子树使用唯一 key，
   并复用整页导航策略；导航模型先 RED，再 GREEN，完整 8 条兼容旅程最后全部通过。
9. 提交后自查发现原先只有焦点断言，没有实际键盘按键；因此补入 Enter 打开核对、Tab 到关闭按钮、
   Enter 提交偏移定位和 Space 展开节点 JSON，再完整运行 **8/8 通过（47.1 秒，无重试）**。
   这次仅补强测试/记录，不修改生产代码或增加功能行信用；不把局部按键验收夸大为全站键盘资格。

## 实际执行与结果

环境：Node 24.22.3 / pnpm 10.20.0，frozen install 成功；tracked 依赖、锁文件、字体配方均未改变。
字体准备初次因容器 CA 链不可验证失败，使用 Node 原生 `--use-system-ca` 后成功；没有禁用 TLS 校验。

| 检查 | 实际结果与范围 |
| --- | --- |
| 聚焦模型与导航 | **43 通过 / 0 失败 / 0 跳过**：41 个 overlap 模型 + 2 个共享导航模型。含完整 Unicode 小语料评分 oracle、所有计算预算、不可变快照、取消/witness、报告无正文、概览独立组合 oracle、顺序链独立二次递推 oracle |
| 全量 `pnpm typecheck`、`pnpm lint` | **通过**；独立 oracle 测试期望补强后再次完整运行通过。额外对两份审计工具执行 strict TypeScript 检查亦退出 0；ADR/文档链接模型 **28/28 通过** |
| `pnpm build` | 已通过，使用真实生产 Web 产物；不是开发模式或生成文件手修 |
| 官方 `pnpm format:check` | 已通过；既有门禁**只覆盖 3 个文件**，不是全仓库格式保证 |
| 显式新增 TS/TSX/审计文件格式检查 | **通过**；包含新增模型/组件/测试/路由及审计工具/JSON。曾发现生成报告数组排版不符，修正生成器的格式输出后重跑通过；没有生产功能信用 |
| 完整根测试（最终串行） | **3258 项 / 2793 通过 / 465 跳过 / 0 失败 / 0 取消**，包含后来新增的 4 个概览模型；前一轮 3254 项不冒充最终数字 |
| 完整 Web（最终固定产物串行） | **303 项 / 285 通过 / 18 跳过 / 0 失败 / 0 取消**。前一轮并行重建窗口发生 8 个 `ERR_MODULE_NOT_FOUND` 失败，明确不算通过；未修改测试，固定产物后整套串行重跑通过 |
| `pnpm test:routes` | **通过**；包括无 API/账号的私有空外壳与查询来源不反射 |
| 兼容 Chromium 153.0.8010.0 | **8/8 通过，无重试**。匿名离线、来源损坏/UTF-8/体积、取消、旧摘要、同步清理/实际返回、原文/JSON 分页、手机/键盘/axe、无正文下载、片段解释、文稿对限定与全局标记；共用 enforcing CSP 自动 fixture，未注册预期违规例外 |
| 官方 Playwright 1.65 Chromium 158 | 本机下载受出网限制，实际 ECONNRESET；**本机未执行官方版本验收**。兼容包仅在 ignored `.local/`，未使用包中关闭浏览器安全策略的参数 |
| `pnpm fonts:check`、`pnpm audit --audit-level high` | 均退出 0；字体核对 **2887 faces**，依赖审计仍有 **1 个 low**，不是零漏洞声明；tracked 依赖和锁文件未改变 |
| 完整本机 `test:all` / 独立 PostgreSQL / 全部 E2E | 本机没有 Docker 命令，且官方浏览器不可用，未执行；数据库相关 skip 不是通过。正式版本与全仓库浏览器/容器资格须看当前提交的远端 CI |

依赖明细仍为既有 `@babel/core` low（GHSA-4x5r-pxfx-6jf8，修复版本 ≥7.29.6）；
文本模式的 `--audit-level high` 门禁退出 0，而额外 JSON 明细查询退出 1，未把该查询说成成功或零漏洞。
本轮不升级/重写锁文件，也不放宽高危门禁。

原始本机日志位于 ignored `verification/writing-overlap/`，不提交依赖、浏览器、构建、数据库、截图或日志。
主要证据名：`analysis-red.log`、`controller-red.log`、`bounds-red.log`、`route-red.log`、
`route-green.log`、`evidence-red.log`、`evidence-controller-red.log`、`map-red.log`、
`navigation-red.log`、`models-oracles-final.log`、`typecheck-map-final.log`、`lint-map-final.log`、
`build-map-final.log`、`browser-map-final.log`、`browser-keyboard-head.log`、`root-serial-final.log`、`web-serial-final.log`、
`routes-serial-final.log`、`overlap-format-verified.log`、`font-check-final.log`、`dependency-audit-final.log`。

合成 pagehide/persisted-pageshow 与实际 `goBack()` 是不同证据；**未证明某次实际返回确实被 BFCache 收纳**。
内存清理不保证物理安全擦除，也不能防御同源恶意脚本、扩展或系统。无正文报告的摘要/坐标/计数仍是私密元数据。

## 本轮独立有效新增生产功能行

基线固定为上面的 `82600ad…`，不把 PR 376/377 或任何先前轮次的代码/测试转为当前信用。

- [主审计脚本](writing-overlap-lines.ts)只准入本轮 17 个新生产模块，擦除 TS 类型/签名/import、
  静态 JSX/标点等，按源码片段对**全部基线生产 TS/TSX**及本轮做去重。
- [逐行语义扣除表](writing-overlap-line-exclusions.json)固定文件、行号、原文与扣除理由。
  继续扣除 DTO/配置/静态文案、被动插值/props、薄事件转发、默认 hooks/ref、旧/重复运行时片段。
  概览和 workbench 的适配组件整份不计信用；路由/导航修复、样式、旧文件上的入口/缓存登记也整份不计。
- [独立复核脚本](verify-writing-overlap-lines.ts)不使用主审计的 Babel 遍历：使用 Node 24 TS 擦除、
  esbuild TSX 擦除/独立 source map 与 Espree 运行时 token，再对全基线和本轮去重。
  检查来源 SHA-256、每项新文件身份、行数、语义扣除表摘要及每个排除 pin；只能拒绝信用，不能补数。
- [主报告](writing-overlap-lines.json)：**1462 候选 − 652 进一步扣除 = 810 有效新增功能行**。
  候选本身已经不含类型/签名、历史/本轮源码重复等；这不是物理新增行数。
- [独立复核结果](writing-overlap-lines-independent.json)：**810 声明 / 810 复核 / 0 拒绝**；
  两个脚本均实际使用 `--enforce` 退出 0，最低 800。本轮测试、文档、审计脚本/输出、生成物和构建修复均不入账。

复现（Node 24、frozen 依赖、当前工作树；生成在 ignored 目录，比较不得忽略退出码）：

```sh
mkdir -p verification/writing-overlap
node docs/audit/writing-overlap-lines.ts --enforce > verification/writing-overlap/reproduced-lines.json
cmp docs/audit/writing-overlap-lines.json verification/writing-overlap/reproduced-lines.json
node docs/audit/verify-writing-overlap-lines.ts --enforce
```

本轮初稿曾只有 791 个运行时确认候选，继续语义扣除后也不满 800；该草稿不作合格证书。
最终口径没有降低排除规则，没有靠测试/文案或重复行补足，而是加入实际可用并独立验证的片段解释与文稿对审阅。

## 未越过的边界与远端状态

- 不上传、持久化、请求来源媒体、写原文件/编辑区/恢复缓存/服务器，不自动去重/合并、重试、发布或重放。
- 不部署，不改基础设施/DNS、凭据或真实账号；只有隔离测试夹具。未读取外部 Docs/Drive/Notion 文档。
- #317 的格式/类型感知 Promise 规则、#331 的生产资格和 ADR 0026/0041–0043 仍独立。
- 此记录不宣称已合并或部署；基线 CI 成功不能替代当前工作分支 exact-head 的 CI/CodeQL 与审阅。
  正式版本和远端检查结论以本轮 PR 的具体提交与检查记录为准，未全绿前不标 Ready，不自动合并或绕过门禁。
