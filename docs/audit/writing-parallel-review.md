# 本轮审阅：本机双语与平行文稿对照审阅 (writing-parallel)

- 基线：`93f516230cb58dc72aedc71b9069c12d97ea1eed`，分支 `arena/d0e09b7c-no-wave`。
- 任务：用户指示“接着做下一轮”，选定新增离线双语/平行文稿对照工具（`/write/parallel`），实现多语言版本骨架树对齐、结构不对称与空缺审阅、双语对照画像、得分拆解解释、只读人工审阅与无正文脱敏报告。
- 架构决策：[ADR 0051](../architecture/decisions/0051-read-only-local-writing-parallel.md)；操作指南：[操作说明](../operations/writing-parallel.md)。

## 前置审阅、复用与安全边界

1. **复用底层平台契约**：
   - 复用 `writing-backup.ts` 与 `writing-collection.ts` 严格的双向 JSON 序列化、fatal UTF-8 校验与 SHA-256 完整性；
   - 复用 `CollectionDownloadLease` 提供受控单次浏览器报告下载；
   - 复用 `bindCollectionPrivacy` 在 `pagehide` 与历史导航过渡时触发原子清理；
   - 复用 `requiresDocumentNavigation` 将 `/write/parallel` 纳入强制整页 Document 导航隔离边界，防止与 SPA 数据加载混淆。
2. **纯本地离线隐私边界**：
   - 不引入任何新的服务器端路由、API 接口、数据库表或第三方运行时 npm 依赖；
   - 杜绝向文稿内提及的任何外部链接或图片 URL 发起静默网络请求；
   - 页面 URL 严格无状态，任何传入的查询参数均在 loader 处重定向剥离；
   - 脱敏报告严格采用白名单投影，绝不包含原文正文、标题或节点结构。

## TDD RED → GREEN 推进历程

1. **RED 阶段**：
   - 在开发任何生产代码前，先建立完整的单测体系：
     - `writing-parallel.test.ts`（对齐与不对称检出主测试，14 用例）
     - `writing-parallel-review.test.ts`（审阅行、有界分页与脱敏报告测试，4 用例）
     - `writing-parallel-controller.test.ts`（双重读取栅栏与状态机，4 用例）
     - `writing-parallel-explain.test.ts`（得分权重明细拆解，2 用例）
   - 首次执行捕获预期失败日志 `verification/writing-parallel/parallel-all-red.log`（退出码 1，ERR_MODULE_NOT_FOUND）。
2. **GREEN 阶段**：
   - 实现 14 个核心库模块：
     - `writing-parallel-model.ts`：数据模型、常量预算与快速哈希；
     - `writing-parallel-symbols.ts`：权重体系、预算计数器 `ParallelMeter` 与策略校验；
     - `writing-parallel-skeleton.ts`：正文骨架树抽取器；
     - `writing-parallel-source.ts`：集合准备、单篇适配与字符预算保护；
     - `writing-parallel-align.ts`：Needleman-Wunsch 动态规划全局对齐、守恒性与单调性校验；
     - `writing-parallel-asymmetry.ts`：空缺、标题层级漂移、外链/图片不对称与极端比例检出；
     - `writing-parallel-ratios.ts`：中位数、MAD、Tukey 栅栏离群点与章节比率漂移统计；
     - `writing-parallel-index.ts`：双向对齐与不对称快速索引；
     - `writing-parallel-profile.ts`：多语言宏观画像与相似度汇总；
     - `writing-parallel-explain.ts`：确定性得分拆解与算法明细解释；
     - `writing-parallel-review.ts`：逐行审阅、代理对安全有界切片与脱敏报告；
     - `writing-parallel-report.ts`：符合 `CollectionArtifact` 契约的报告生成器；
     - `writing-parallel-controller.ts`：双重读取栅栏控制器；
     - `writing-parallel.ts`：主入口编排器。
   - 解决 Node 24 `--experimental-strip-types` 模式对构造函数参数属性（parameter properties）的语法限制，改用显式字段初始化。
   - 单元测试 24 项全绿通过。
3. **前端 UI 与外壳接入**：
   - 实现 `writing-parallel-workbench.tsx`、`writing-parallel-review.tsx`、`writing-parallel-profile.tsx`、`writing-parallel-explanation.tsx`；
   - 路由挂载 `apps/web-rr/app/routes/write.parallel.tsx` 并登记 `routes.ts`；
   - CSS 全局样式适配 `.nw-parallel` 系列类目。
4. **Playwright 端到端测试**：
   - 编写 `e2e/writing-parallel.spec.ts`；
   - 验证匿名 URL 重定向、离线模式、零外部网络请求、画像表格渲染、逐行核对与标记、算法解释展开、无正文脱敏报告下载（验证绝对不含机密手稿文本）以及 Axe 无障碍合规（0 serious/critical 违规）；
   - 测试耗时 3.1s，全绿通过。
   - 回归运行 `e2e/writing-cadence.spec.ts` 8 项测试全部通过。

## 检查与门禁状态

| 门禁检查项                                     | 结果状态                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 核心单元测试（`writing-parallel*.test.ts`）    | **24/24 通过，0 失败**，耗时约 890ms                                                                                                  |
| 独立文档导航测试（`document-navigation`）      | **5/5 通过，0 失败**，`/write/parallel` 隔离规则验证通过                                                                              |
| 全量 `pnpm build`（React Router & Vite）       | **成功构建**，0 错误，客户端与服务端产物正常输出                                                                                       |
| Playwright E2E（`writing-parallel.spec.ts`）   | **1/1 通过，0 重试**，离线执行成功，Axe 0 违规                                                                                        |
| 既有 E2E 回归（`writing-cadence.spec.ts`）     | **8/8 通过，0 失败**                                                                                                                  |
| 字体检查（`pnpm fonts:check`）                 | **2887 faces 验证通过，退出 0**                                                                                                       |
| 依赖漏洞审计（`pnpm audit --audit-level high`）| **退出 0**，无 high/critical 漏洞                                                                                                     |
| 独立功能代码行双重审计（主审计与独立验证器）   | **885 声明 / 885 复核 / 0 拒绝，满足 > 800 行标准**                                                                                    |

## 独立有效新增生产功能行双审计

- **主审计工具**（`docs/audit/writing-parallel-lines.ts`）：
  - 严格限制审计范围为本轮 14 个新生产核心库模块；
  - 采用 Babel 解析 AST，擦除 TypeScript 类型、签名、import 声明、标点与静态 trivia；
  - 依据基线 commit `93f516230cb58dc72aedc71b9069c12d97ea1eed` 对全版本库历史生产代码做规范化文本去重；
  - 结合 `writing-parallel-line-exclusions.json` 逐行扣除 20 处样板声明、空集合初始化与重复框架代码；
  - 统计得出有效功能代码行：**885 行**（> 800 行标准）。
- **独立复核工具**（`docs/audit/verify-writing-parallel-lines.ts`）：
  - 采用 Node 24 原生 TypeScript 擦除 + Espree ECMAScript 语法分析器生成运行时 Token；
  - 独立比对全版本库历史运行片段与同轮重复片段；
  - 验证证书哈希、文件 SHA-256 与排除项规则；
  - 结果：**声明 885 行 / 独立复核 885 行 / 0 处不一致 / 0 处失败**，`satisfied: true`。
- 双审计执行 `--enforce` 均以状态码 0 顺利通过。
