# 文稿集合备份与离线核对：独立功能行与边界审阅

## 口径与复现

- 固定基线：`e53904a2e6d3ae8aab38d10f18542b64c52a6581`。历史 PR #342 的 803 行及更早交付全部排除，不将测试算入生产功能。
- 复现：Node 24、冻结安装后运行 `node docs/audit/writing-collections-lines.ts`。逐文件 SHA-256、候选/排除/最终行号在 [`writing-collections-line-count.json`](./writing-collections-line-count.json)；人工语义扣除的原文、行号与理由在 [`writing-collections-line-exclusions.json`](./writing-collections-line-exclusions.json)。源文件变化使原文扣除项过期时脚本失败，低于 800 时也失败。
- 先按 AST 取得 git 新增的可执行 token 行，排除测试、注释/空白/纯标点、import、擦除的类型/声明/注解、静态 JSX 标记与文字。再排除整个基线生产 TS/TSX 的规范化相同行、本轮跨文件重复片段，最后独立人工扣除改写/搬移/模板及语义复用。以行计数，不按一个长行上的语句数拆开累计。
- 不计 API/RR 薄接线、导航、测试注册、静态语义 landmark 修正、CSS、文档、审计/验证脚本与生成物；没有借重排、改名、翻译、拆函数或堆控件文字补数。

**最终：959 候选 − 153 人工语义排除 = 806 行新增有效生产功能。** 不是 `git diff --stat`、总文件行数或“实现＋测试”之和。

| 文件（`packages/web-ui/src/` 下） | 候选 | 语义扣除 | 有效新增 |
| --- | ---: | ---: | ---: |
| `lib/writing-collection.ts` | 118 | 5 | 113 |
| `lib/writing-collection-index.ts` | 71 | 6 | 65 |
| `lib/writing-collection-controller.ts` | 173 | 16 | 157 |
| `lib/writing-collection-browser.ts` | 54 | 7 | 47 |
| `lib/writing-collection-export.ts` | 65 | 5 | 60 |
| `lib/writing-collection-search.ts` | 36 | 2 | 34 |
| `lib/writing-collection-references.ts` | 51 | 1 | 50 |
| `lib/writing-collection-review.ts` | 108 | 7 | 101 |
| `lib/authoring-catalogue-open.ts` | 8 | 1 | 7 |
| `lib/writing-backup.ts` | 5 | 2 | 3 |
| `components/authoring/writing-collections.tsx` | 85 | 25 | 60 |
| `components/authoring/writing-collection-export-panel.tsx` | 28 | 8 | 20 |
| `components/authoring/writing-collection-document.tsx` | 27 | 10 | 17 |
| `components/authoring/writing-collection-comparison.tsx` | 36 | 22 | 14 |
| `components/authoring/writing-collection-search.tsx` | 21 | 10 | 11 |
| `components/authoring/writing-collection-references.tsx` | 33 | 15 | 18 |
| `components/authoring/writing-collection-review.tsx` | 40 | 11 | 29 |
| **合计** | **959** | **153** | **806** |

### 人工排重重点

旧严格单篇 JSON、检查统计、纯文本/Markdown 导出、有界文稿差异、引用审计、CSV 公式保护、目录实时账户核验均复用而非重写；旧算法及只转调的展示/包装不再计数。特别再扣除旧单篇差异的相同块开关、通用 pagehide/BFCache 绑定模式、重复清除包装、状态别名和纯条件容器。新计数属于集合级格式/摘要/预算/字段歧义防护、串行完整队列与身份意图、两独立文件生命周期、明确子集/配对、跨文稿检索/引用聚合、计划预览应用及内容最小化报告。

## 审阅的具体风险与处理

1. **完整性并非身份**：格式只持有文件内 `d1…d20` / `w1…w20`，逐篇与有序清单 SHA-256。明确不称签名、账户凭据、服务器快照或媒体所有权。旧单篇输入只称结构校验；规范化生成的新摘要不追溯证明旧原件完整性。
2. **不可信文件与资源预算**：16 MiB / 20 篇，沿用每篇 2 MiB / 节点 / 文字 / 深度 / 顶层块约束；按文件字节先拒绝，严格 UTF-8，检查实际读回字节数。原生 JSON 解析前迭代拒绝解码后重复键（包括转义写法）和 64 层以上外壳，避免规范化摘要吞掉早先字段；仍执行未知字段/危险键/URL/旧格式及完整摘要验证。不接纳部分条目，不以弱 hash 降级。
3. **目录正文最小读取**：只串行读取明确选择的在用语言版本，用原精确 id/locale/expected-author reader；任何失败停止队列，没有自动重放或可下载半包。账户拒绝清私有进度，429 带回等待期限；实际下载再次核验会话。
4. **晚到与相同值重新选择**：不仅对比字段 fingerprint，还保留原选择身份。文件读取/摘要、准备、比较、检索、引用与计划分别有取消/版本见证；旧渲染控件也须持有当前结果/预览对象，不能凭复用的 `r1` 或匹配 ID 定位/应用新内容。pagehide/BFCache 通过同步 flush 清私有 DOM，返回不重读。
5. **本机不获得服务器权限**：匿名 `/write/collections` 仅空壳，no-store/noindex，去除 query 参数，不自动加载文件地址；没有 API 写入、上传、自动浏览器存储、图片/链接获取或数据遥测。导出单篇后仍须在旧写作工具重新预览恢复，后端媒体所有权、dirty/pending/revision/精确重试与 signed import 均未改动。
6. **明确、不推断**：两来源相同组号不合并；显式跨筛选选择最多 20 篇，披露隐藏选择与等价提示，不去重。左右配对一对一，不按标题/组号/顺序推断，未配对不说新增/删除。差异、全文检索及引用清单均披露预算与未检查部分，不把未检查说成相同/无结果。
7. **报告隐私与可交接性**：计划只含摘要和局部选择/配对，64 KiB 上限，先校验预览、明确应用，不自动恢复/比较。报告只复制固定无正文字段；默认不含标题/文件名，永不序列化正文、链接地址、差异片段或查询词。JSON/CSV 均保留覆盖数、问题代码计数与有界变化块位置。CSV 不可关闭旧公式/控制字符保护。Blob 类型/文件名/字节与实时见证检查，失败/离开/新下载回收 URL；兼容旧便携文件名的前导下划线。

## 验证证据的解释

- 失败回归包括：相同值重新选择的旧意图、长分隔符文件名的超时、原生 JSON 重复字段被吞、旧结果 ID 复用、CSV 下载租约格式限制、前导下划线文件名及读回字节不符；修复后保留对应测试，不改超时/跳过断言来变绿。
- 新模型/控制器/浏览器适配器测试显式加入根测试清单；真实浏览器覆盖离线拆包/子集、搜索定位、计划预览/报告、摘要损坏/非法 UTF-8/超限、晚到摘要、BFCache 同步清理、恶意外观文本/移动布局/axe，以及实际目录串行正文下载/取消/429/实时账户拒绝。
- 层级测试存在重叠，不能把根、PG、Web、HTTP、E2E 的数量相加称作独立覆盖。根中的 PostgreSQL 条件跳过必须另跑真实 PG，不能只凭本机 root green 宣布验收。
- 当前沙箱没有 Docker，`pnpm test:all` 实际以 `spawn docker ENOENT` 退出 1；本机分层执行真实 PostgreSQL 17.9 和四独立 SQLite 浏览器栈作为补充，不冒充 Docker/官方 Chromium 验证。沙箱浏览器使用本地临时 Chromium 153，产品依赖、Playwright 配置及 CI 均未替换/放宽。
- `pnpm audit --json` 实际退出 1：只有基线已存在的 `@babel/core@7.28.5` / `GHSA-4x5r-pxfx-6jf8`（low 1，moderate/high/critical 0），不说无漏洞；本轮没有改产品依赖/锁文件。
- 最终逐层 pass/fail/skip、精确 PR HEAD 的真实 required CI、fetch 冲突复审与 PR 状态在中文 PR 描述/最终审阅备注中持续记录。未运行或仍在执行的检查不写成成功；不自动合并或部署。
