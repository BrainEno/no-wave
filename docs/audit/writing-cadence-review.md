# 本轮审阅：本机写作停顿与配对节奏审阅

Status: archived

- 基线：`491e6e91fe4a4d7ae8fee6126e35b6421cc3eb9e`，分支 `arena/f19dccbc-no-wave`。
- 范围：用户委托自主选择下一轮功能；本轮为写作停顿与配对节奏审阅（停顿片段切分、长短句统计、成对符号栈匹配、配对×停顿边界差分交叉画像、隐形字符与只读人工审阅）。
- 设计：[ADR 0050](../architecture/decisions/0050-read-only-local-writing-cadence.md)；流程/限额：[操作说明](../operations/writing-cadence.md)。
- 不把先前 PR 379 的功能、803 行、CI 或浏览器结果转为本轮信用。

## 前置审阅、复用与风险

读取根 AGENTS（无嵌套规则）、需求基线/测试策略/共享模块索引、collection/search/index/controller/browser、
`writing-document`、单稿替换、段落重叠、三方合并、密码备份、术语审阅及调用者/测试，并核对开放 issue 清单。
已有单串查询、不重叠替换、段落相似度或术语字典均不提供停顿标点疏密、嵌套配对跨度与边界交叉画像；
新算法不复制任何编辑或自动润色权限。

复用严格备份/集合校验、`readCollectionJson`（含重复/危险键拒绝）、摘要、`inspectWriting` / `writingNodeAt`、
原生本机字节读取、惰性有界文字分页、`CollectionDownloadLease`、隐私过渡清理、整页导航和私有页头。
新停顿流式切分、成对符号显式栈、反向二分与差分扫描交叉算法与既有单串检索和段落近似语义完全不同。
控制器保留两个显式输入的独立 fence，不引入新的存储、网络请求、身份或媒体策略。

风险为本机敏感数据/并发/报告真实性，严格遵循 test-first 原则。
不上传，不读取外部网络文档，不写编辑区、原文件、服务器或恢复缓存；无依赖、锁文件或生成协议变更。

## RED → GREEN 与实际修正

1. 配对×停顿边界交叉（crossings）占位实现的 2 个测试实际 RED，确认退出码非 0（`crossings-red.log`）；
   实现反向区间 join 与差分扫描后全部通过（`crossings-green.log`）。
   严格实施 incidences ≡ seam depths 数学守恒校验与 run 连续性断言，发现跨 run 或顺序颠倒立即抛错拒绝。
2. 停顿流式切分与标点计数的 8 个占位测试实际 RED（`model-red.log`），实现后通过（`model-green.log`）。
3. 审查列表与原文分页高亮的 6 个占位测试实际 RED（`review-red.log`），实现后通过（`review-green.log`）。
4. 控制器双读取栅栏与状态机的 7 个测试实际 RED（`controller-red.log`），实现后通过。
5. 导航隔离测试在未登记新路由前实际 RED（`navigation-red.log`），完成路由与 Document 边界适配后通过。
6. 逐边界与逐配对的独立 oracle 遍历验证差分扫描在 1–12 层嵌套下的正确性，确保边界穿透不遗漏。
7. 兼容浏览器测试覆盖匿名访问、文件选入、策略切换、画像展现、定位联动、无明文报告下载与离页清理。

原始日志保留在 ignored `verification/writing-cadence/`，不向版本库提交浏览器临时文件、依赖包、日志或截图。

## 检查状态

以下结果均已检查实际输出；未运行和跳过不作通过。

| 检查                                                 | 结果                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 聚焦停顿/导航                                        | **32/32 通过**，0 失败/跳过；含 crossings 2、explain 5、controller 7、review 6、cadence 8、navigation 4                                                               |
| 全量 `pnpm typecheck` / `pnpm lint` / `pnpm build`   | **全部退出 0**，真实生产构建，含脚本/E2E 类型与全量 CSS/TS/TSX lint                                                                                                   |
| 完整根测试 | **3313 项 / 2848 通过 / 465 跳过 / 0 失败 / 0 取消**；跳过项均为无 Docker/PostgreSQL 外部环境 |
| 完整 Web                                             | **305 项 / 287 通过 / 18 跳过 / 0 失败 / 0 取消**，包含新外壳/重定向/CSP；与构建串行                                                                                  |
| `pnpm test:routes`                                   | **退出 0**，含无账号/API 的新本机外壳和 URL 不选规则                                                                                                                  |
| 兼容 Chromium 浏览器                                 | **22/22 通过，无重试**；含本轮 8 条及既有回归。此前失败不冒充通过                                                                                                     |
| 字体 / high 依赖门禁                                 | `pnpm fonts:check` **2887 faces，退出 0**；`pnpm audit --audit-level high` **退出 0，仍有 1 low**，不是零漏洞；依赖和锁文件不变                                       |
| 格式                                                 | 官方文件 `pnpm format:check` **退出 0**；全部新增 TS/TSX、审计工具与配置显式 Prettier 检查通过                                                                        |
| 审计工具 strict TypeScript、文档链接/ADR             | 两份审计工具独立 strict TypeScript **退出 0**；ADR 索引/文档链接/本机开发文档 **28/28 通过**                                                                          |
| 全部本机 `test:all` / Docker/PostgreSQL / 官方浏览器 | 本机没有 Docker；官方 Chromium 下载主机不在可用出网清单，本机未执行这些资格。兼容 Chromium 153.0.8010.0 来自 ignored npm 包，不冒充 Playwright 1.65 官方 Chromium 158 |

本机 Node 24.22.3 / pnpm 10.20.0 已安装于 ignored `.local/`，frozen install 退出 0。
字体准备使用 Node 原生系统 CA，未关闭 TLS 检查。兼容浏览器不使用关闭 Web 安全参数；
浏览器旅程继续使用 enforcing CSP fixture，不登记违规豁免。合成隐私过渡和实际 goBack 均不是 BFCache 实际收纳证明。

## 独立有效新增生产功能行

- [主审计](writing-cadence-lines.ts)固定本轮 13 个新 lib 模块，不准入类型模型、UI、路由、导航、样式、入口登记、测试、文档或工具。
- 擦除 TS 类型/签名/import/标点，对**全部基线生产 TS/TSX**及本轮做去重，再用[逐行语义扣除表](writing-cadence-line-exclusions.json)
  扣除 DTO/配置/静态文案/薄封装/重复策略。**整个控制器、报告与编排模块候选均额外扣除**，不靠新命名的旧状态/投影模式补数。
- [独立复核](verify-writing-cadence-lines.ts)使用 Node 24 TS 擦除、独立运行时 lexer 与全基线去重，检查 SHA-256、
  新文件身份和逐行扣除 pin；只能拒绝，不能补数。
- 最终[主报告](writing-cadence-lines.json)：**1683 候选 − 751 进一步扣除 = 932**。
  [独立证书](writing-cadence-lines-independent.json)：**932 声明 / 932 复核 / 0 拒绝**。两脚本均实际 `--enforce` 退出 0。
- 原 PR 379 及任何历史实现均留在基线，不能再次计数。物理新增行数不是有效功能行。

复现（Node 24、frozen 依赖，不能忽略 cmp 退出码）：

```sh
mkdir -p verification/writing-cadence
node docs/audit/writing-cadence-lines.ts --enforce > verification/writing-cadence/reproduced-lines.json
cmp docs/audit/writing-cadence-lines.json verification/writing-cadence/reproduced-lines.json
node docs/audit/verify-writing-cadence-lines.ts --enforce > verification/writing-cadence/reproduced-independent.json
cmp docs/audit/writing-cadence-lines-independent.json verification/writing-cadence/reproduced-independent.json
```

## 残余风险、变更范围与远端

使用中的正文仍是内存明文；清引用不等于安全擦除，同源脚本/扩展/系统风险不消失。
报告无正文明文，但分布直方图、摘要、坐标仍敏感，可能推断句长与标点结构；停顿统计不是风格优劣证明。
证书 SHA-256：主报告 `f9ee97a4d15432cd63a6065aebee58c2cdc502b5726b6fe154491a48a1402866`；
独立证书 `388c50c9af95e15d18c2e8a5ff286af97209b575572d2fb07ee019f7c5c7edd2`。

本轮不关闭 #317 的 type-aware Promise 缺口，不越过 #331 或 ADR 0026/0041–0043 的生产门禁。
无部署、账号配置、密钥轮换、自动修复或外部 Docs/Drive/Notion 访问。远端精确提交的 CI、Ready 和合并状态
必须另行观察，不能从本地记录推断。最终 diff 只含本轮停顿审阅、必要入口与对应测试/文档；无真实用户数据、秘密、依赖/锁文件或无关改动。
