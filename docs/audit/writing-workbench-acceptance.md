# 写作台文稿工具：范围、安全与独立行数验收

固定增量基线：`1aecb065ce29f354bee6c36ebca52761d349c59b`；分支 `arena/c2d313d2-no-wave`。本轮调研已有写作台、Lexical 文档适配器及开放的 UI backlog 后，选择连续的作者任务：未保存保护、文稿检查/章节大纲、作用域查找替换、本机备份与差异/选择性恢复、离线引用清单。不是重复既有阅读清单、续读、阅读查找或标签功能，也不以这次扩展关闭整个 #284/#286。

行为和预算的 source of truth 见 [架构说明](../architecture/writing-workbench.md)。风险为**中**，主要是丢稿、保存/退出期间的异步编辑、陈旧预览、本地文件输入与富文本格式保留。不新增 API、迁移、自动浏览器存稿、账户同步、遥测或服务器权限规则。

## 行为与关键文件

| 任务 | 实际行为 | 文件（相对 `packages/web-ui/src/`） |
| --- | --- | --- |
| 未保存保护 | 语义基线、提交快照确认、未知创建重放只确认服务器实际内容；新建/切换/路由/退出/unload 保护；旧确认不能授权新编辑器版本 | `lib/writing-session.ts`、`components/authoring/article-editor.tsx`、`authoring-workspace.tsx` |
| 文稿检查与大纲 | 有界扫描、可定位结构问题、字符/词组/阅读时长、嵌套章节前缀统计；不评价文风、不替代 API 校验 | `lib/writing-document.ts`、`components/authoring/writing-tools.tsx` |
| 作用域查找替换 | 字面 Unicode 匹配、逐项选择、上/下处精确正文选择、拒绝陈旧快照；不改图片/代码/链接地址，整批正文一次撤销 | `lib/writing-replace.ts`、`components/authoring/writing-tools.tsx` |
| 本机备份与恢复 | 严格版本化 JSON、纯文本/Markdown；字段/块差异、格式变化、确定性移动匹配；可替换正文或按文件顺序追加勾选块，不自动保存/发布/新建 | `lib/writing-backup.ts`、`writing-compare.ts`、`writing-restore.ts`、`components/authoring/writing-restore-preview.tsx` |
| 离线引用清单 | 安全规范化分组、同名异址/空描述/HTTP 提示、筛选与原节点定位；不请求地址，不宣称可达性或媒体归属 | `lib/writing-references.ts`、`components/authoring/writing-references-panel.tsx` |

备份只提取五个可编辑字段，不附加账户、作品 ID/slug、发布状态、revision、令牌或重试标识。作者自己写入正文或链接的内容原样保留；“不附加身份凭据”不代表会扫描或脱敏正文。文件未加密、不包含图片原文件；远程图片恢复需明确同意，站内媒体最终仍经后端所有权检查。标题/摘要/语言/类型不在富文本正文撤销栈内，界面明确说明。

## 独立有效生产代码审计

运行：

```sh
node docs/audit/writing-workbench-lines.ts > docs/audit/writing-workbench-lines.json
```

本轮固定基线下，**933 候选 − 106 项语义扣除 = 827 行有效新增生产功能代码 / 12 个文件**，不把测试、文档、配置或生成物算进 800 行门槛。精确行号与源码 SHA-256 见 [结果](writing-workbench-lines.json)，逐片段扣除理由见 [语义排除表](writing-workbench-line-exclusions.json)。

| 不重叠分组 | 有效行 |
| --- | ---: |
| 会话、ArticleEditor 与 Workspace 的实质保护 | 137 |
| 文稿检查与章节统计模型 | 133 |
| Lexical 查找替换与锚点模型 | 51 |
| 本机备份、块差异与选择性恢复模型 | 261 |
| 离线引用模型与筛选/定位面板 | 79 |
| 文稿工具交互与恢复选择面板 | 166 |
| **合计** | **827** |

方法先按 Git 固定基线识别变更行，再用 AST 排除注释、空白/标点、imports、type/interface、类型标注和静态 JSX；去除基线所有生产 TS/TSX 已有的规范化行、重复新增片段。最后另行复核展示字典/状态/片段、旧监听搬移、组件包装、依赖尾部、通用下载锚点、既有阅读查找的循环导航/片段和安全正则，保守扣除。CSS、审计脚本、所有测试（包括下面的 worker 测试修正）均为零计数。

## 回归边界与发现的真实问题

- 模型测试先证明保存后继续输入、陈旧离开 token、无效/危险文件、陈旧查找/恢复、块追加原子性等失败，再实现；新测试均登记在根 `test` 的显式清单中。
- 真实 Lexical 运行时会增加默认字段、合并相同格式文字及同地址相邻链接。初次打开必须同步运行时路径，语义 dirty 判断不得因此误报；下载运行时 JSON 再读取也不能制造假差异。
- 有界扫描不能先对整个子节点数组 `map/forEach` 再丢弃结果。用预算之后会抛错的子节点访问器作负例，要求检查和引用清单真正停止后续读取；超过 200 顶层块必须标记部分结果。
- `LinkExtension` 只注册普通 link，因此本机文件拒绝未注册的 autolink，不能把它留给 Lexical 解析时才失败。
- 500000 字符的代码块可能包含 250000 段反引号。旧的参数展开求最大值会栈溢出，现用迭代计算 Markdown 围栏长度，保持原始代码字节。
- 新增展开面板的 axe/桌面与 375px 手机验收，覆盖查找结果、长引用地址和备份控件，要求无 serious/critical 违规、无横向溢出、可见按钮至少 44px 高。查找定位按钮的可访问名称必须包含可见文字，不能只在折叠面板上验收。
- 既有多语言 E2E 原来直接丢弃取消保存后的语言编辑，以及尚未收到保存响应的输入；现在显式取消/确认新的离开警告，增加“确认切换不产生翻译写入”断言。保留原有语言独立性、回收站、删除及旧请求不能替换新编辑器的全部断言。
- 固定基线 CI 的 PostgreSQL worker 用例曾在 `worker_ready` 后立即断言 `idle`，实际可合法处于首次异步 `delivering`。仅修正测试同步：有界等待首次批次完成且进入 idle，再验证原来的 ready=200、持久通知、60 秒等待被 SIGTERM 打断、退出码、预算、清理和隐私断言；不改 worker 生产实现，不放宽或跳过断言。

## 实跑证据与限制

最终本地各层 pass/fail/skip 和精确 HEAD 的 required CI 状态记录在 PR 正文/验收评论中；重叠子集不相加充当总数。工具链为 Node 24.22.3 / pnpm 10.20.0，使用真实 PostgreSQL 17.9 和 Chromium 153；不改应用依赖或 lockfile。

沙箱无法使用官方安装位置的 Playwright Chromium，也没有 Docker；本地 `pnpm test:all` 确实在浏览器预检 exit 1，不能声称官方聚合入口通过。替代验证仅调整本地忽略目录中的浏览器二进制/系统库位置，完整浏览器清单以零重试四个隔离分片运行；数据库层使用临时真实 PG，不用 SQLite 冒充。官方聚合入口、容器及 required gate 仍由 PR 的真实 CI 证明。

一次并行执行 `verify:publish` 会通过 portable stack 重建 Web，覆盖正在运行的浏览器静态资源；失败日志实际出现 JS/字体 404。最终浏览器回归必须在构建/发布探针之后启动，整个过程不再重写 build，不能把那次失败计为通过。

依赖审计本轮为既有 `@babel/core` / `GHSA-4x5r-pxfx-6jf8` **1 low、0 moderate/high/critical**；`pnpm audit --json` exit 1，`pnpm audit --audit-level high` exit 0。不借本轮功能未经评估地升级依赖，也不称零漏洞。

保留 API revision、expected actor、未确认创建的精确重试字节、媒体所有权、生产限流、签名导入和既有阅读/标签能力。临时数据库、工具链、截图和大日志不入 Git；本轮只开 PR，不自动合并、部署或关闭 issue。
