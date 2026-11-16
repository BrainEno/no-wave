# 本机阅读清单、显式续读与文内查找：本轮验收

## 选择、范围与风险

固定增量基线：`ba5c73b1915e74fe7a444f85f31755b1adc834af`，分支 `arena/2a5b2a10-no-wave`。调研现有阅读器、行为基线、ADR 0020/0021/0023 及开放事项后，按仓库实际的文学阅读产品定位，补齐三个相连的读者任务，而不是重复已交付的标签、通知或导入能力：

1. **本机阅读清单**：保存具体语言版本、待读/在读/读完、组合筛选/排序、20 条分页、跨页选择与批量操作、JSON 备份和带预览的恢复。
2. **明确许可的位置记忆与续读**：保存作品不会自动跟踪；逐版本主动开启后，只有真实阅读输入后的移动才采样。再次打开不自动滚动，点击续读后验证原文 witness；fragment 和较新的用户意图优先。
3. **文内查找与键盘导航**：只搜索当前已加载正文，字面匹配、大小写/宽度选项、原文 offsets、上下处/F3/Shift+F3/Escape/IME，Highlight API 不改写作者 DOM。缺少 Highlight 时仍可定位；缺少 `Intl.Segmenter` 时明确转用浏览器查找，不让整页 hydration 崩溃。

风险为**中**：浏览器本地隐私、并发覆盖、文件输入和焦点/滚动所有权。最小业务边界为共享阅读 UI/纯模型、两个本机页面路由与外壳接线；不增加数据库迁移、API、后台历史、同步、遥测或账户权限。相关行为、Given/When/Then、节流和生命周期限制见 [架构说明](../architecture/local-reading-list.md)。

## 关键文件与集成

| 能力 | 文件 |
| --- | --- |
| 模型、校验、筛选与身份 | `packages/web-ui/src/lib/reading-shelf.ts` |
| 单条 revision/许可、跨 key 部分确认、Web Locks 调度 | `reading-shelf-store.ts`、`reading-shelf-actions.ts`、`components/reader/reading-shelf-provider.tsx` |
| 1 MiB/200 版本备份、导入预览与许可剥离 | `reading-shelf-backup.ts`、`components/reader/reading-shelf-transfer.tsx` |
| 位置 witness、真实输入、取消/离开与滚动桥 | `reading-position.ts`、`use-reading-position.ts`、`reader-location.ts`、`components/chrome/site-chrome.tsx` |
| 查找 offsets、范围与高亮/焦点生命周期 | `reader-find.ts`、`components/reader/reader-find.tsx` |
| 文章/清单页面、语言导航、私有空壳 | `components/reader/article-reading-list.tsx`、`reading-list.tsx`、`components/public/article-view.tsx`、`apps/web-rr/app/routes/reading-list.tsx` |

上表省略的 `lib/`、`components/` 相对路径均属于 `packages/web-ui/src/`。保留既有朗读、划线、标签、账户、阅读计数和通知能力；“本机、不上传”只描述这次新增的清单/位置/查找词，不宣称文章页没有原有网络行为。

## 独立有效生产行数

执行 `node docs/audit/reading-shelf-lines.ts > docs/audit/reading-shelf-lines.json`，固定基线后得到 **940 候选 − 87 语义扣除 = 853 行**，满足至少 800 行的要求。按文件的精确行号、源码 SHA-256、方法和扣除理由见 [审计结果](reading-shelf-lines.json) 与 [人工排除表](reading-shelf-line-exclusions.json)。

| 功能分组 | 有效新增行 |
| --- | ---: |
| 清单模型、持久化、备份、锁调度 | 250 |
| 位置模型、hook 与滚动/焦点定位 | 137 |
| 文内查找模型与交互组件 | 213 |
| 页面、provider、备份交互与外壳实质行为 | 253 |
| **合计** | **853** |

测试、文档、审计/诊断脚本、配置、字典、静态展示、CSS、字体生成物均不计入。AST 排除 import、type、注释、空白/标点、纯静态 JSX；再去除基线所有生产模块已有的规范化行、重复新增片段及保守的搬移/接线/展示扣除，不重计历史 PR。Node reporter 与字体配方虽有实质修复，也未用来凑本轮产品功能行。

## Red → Green 与未削弱的边界

- 存储/许可/超限/锁协调：先有失败证据，再实现或补齐修复；双标签页同时覆盖不同作品、陈旧 revision、清空/导入预览过期、撤回许可先于排队 checkpoint、quota/损坏记录和部分确认。
- 真实浏览器曾证明合成 `WheelEvent` 加程序化滚动错误地写入进度；修复为 trusted 阅读输入，并保留默认关闭、到达不写、组合输入/缩放保护。GSAP 下原生焦点 reveal 会改变按钮位置，改为由 transform owner 接管，不使用 force-click 绕过。
- 缺少 `Intl.Segmenter` 的浏览器在新增负例中不能打开查找框；现在给出浏览器查找指引，正文与清单控件继续工作。
- 完整浏览器首轮 **203 通过/1 失败/0 跳过**：字体 **634,072 字节**超出原有 **600,000 字节**预算。首次将整份字典加入 interface 后仍为 **629,600 字节**，没有把它报告成修好。最终按初始控件/展开工具分层后，专项冷传输实测 **596,552 字节**，原断言与实际字体验证均通过。
- 上述失败尝试分别保留在本地隔离验证日志中；没有修改预算、关闭安全策略、删字形、跳过失败断言或启用重试来取绿。无 Highlight 和无分词 API 是被测的产品降级，不是跳过测试。

## 最终验证

所有数值均为本轮实跑的 pass/fail/skip；子集与完整套件重叠，不相加充当去重总数。验证使用仓库固定的 Node **24.22.3** / pnpm **10.20.0**；隔离工具为真实 PostgreSQL **17.9** 与 Chromium **153.0.8010.0**，没有变更应用依赖或 lockfile。

| 检查 | 通过 | 失败 | 跳过 | 状态/说明 |
| --- | ---: | ---: | ---: | --- |
| 最终根测试，注入隔离真实 PostgreSQL | 2540 | 0 | 0 | 完整 package 测试清单；495,243.164354 ms，不继承开发者凭据或 `.env` |
| 最终完整 Web 测试，真实 PostgreSQL | 281 | 0 | 0 | 同一最终生产构建；150,389.231396 ms |
| 最终完整浏览器，36 文件/四独立分片 | 205 | 0 | 0 | 52 + 53 + 49 + 51；retries=0、flaky=0，逐分片临时 SQLite，保留 JSON 报告 |
| 字体完整性/策略单测 | 20 | 0 | 0 | 含字典归属与延迟分片不重叠回归；亦属于根测试 |
| 代表性文章字体冷传输专项 | 1 | 0 | 0 | 596,552 字节；实际字体、同源和 immutable/HEAD 均验证；最终完整浏览器中亦同值通过 |
| 无邮箱服务发布可见性 `verify:publish --json` | 9 | 0 | 0 | 独立临时栈，从注册/档案/写作台代理发布到匿名 API/SSR/列表可见 |

最终浏览器报告同时记录登录/注册累计字体 **212,408 字节 < 300,000**，五次普通动效桌面首页冷加载的最大 CLS 均约 **0.00470416 < 0.05**；未取平均、舍弃采样或重试。22 条新增阅读旅程全部包含在 205 条完整回归中。

`pnpm typecheck`（含脚本/E2E）、完整 `pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm fonts:check`、`pnpm openapi:check`、`pnpm slices:check`、`pnpm test:routes` 均 exit 0。format 仅覆盖仓库脚本所列三个文件，不声称全库格式化。

本地 **`pnpm test:all` 实际 exit 1**，在标准 Playwright Chromium 缺失的预检停止；环境同时没有 Docker，因此 Docker 镜像 smoke 与官方聚合入口未完成。上表真实 PG/隔离 Chromium 回归不是把官方入口伪装为通过；required CI/CodeQL 以本 PR 的精确 HEAD 为准。基线 main 自带的 13 success / 3 failure 另行保留事实：失败为 PG/full-local-suite/汇总，受日志 EOF 限制未取得断言根因，不能把本地通过说成本轮已修复基线 CI，也不关闭相关开放事项。

## 字体、依赖、安全与剩余限制

- `scripts/fonts/repertoires.ts` 与 `scripts/lib/font-assets.ts` 按 UI 使用阶段为字典分片；按固定来源/校验和运行原有生成器，CSS、manifest 与 WOFF2 一并提交。完整 **2,887 faces / 35,074,632 字节**，各来源/字重的原始非控制字符覆盖和许可证不变；生成物不计功能行。大量 Noto Sans 文件差异是重新分配字形所致，不是额外引入在线字体服务。
- 源字体下载首次遇到本地 CA 信任失败，仅用 Node `--use-system-ca` 后重试，未关闭 TLS 校验；`.cache`、临时 Chromium/PG 工具、数据库、截图和大日志均未纳入 Git。
- `pnpm audit --json` 本轮 exit 1：既有 `@babel/core` / `GHSA-4x5r-pxfx-6jf8` **1 low、0 moderate/high/critical**；`pnpm audit --audit-level high` exit 0。没有新增应用依赖，也不称零漏洞。
- HTML/data/HEAD 实测本机页面 no-store/noindex、匿名与登录同一空壳、不读 cookie/私有 API、不进入 sitemap；SSR 不含本机记录。备份的链接只由受限 locale/slug 重建，标签由 React 转义，不接受导入 URL、HTML 或跟踪许可。
- Web Locks 不可用时只读/导出，不能以 localStorage get/set 冒充跨标签 CAS；跨 key 不是事务，失败必须报告确认条数。共用浏览器共用清单，清除站点数据会丢失记录；没有同步、离线正文或加密备份承诺。
- 位置每约一秒节流；隐藏/SPA 离开仅尝试提交已经采样的移动，整页离开取消待锁任务。最后一秒/崩溃不保证保存，不能用无锁写回假装保证。文本变动或歧义不近似续读，查找有可见的长度/数量上限。
- 差异审查未发现真实凭据、生产数据、部署配置、API 授权/限流/所有权规则或无关业务修改。`scripts/github-test-reporter.ts` 只补充可读日志之外的 GitHub 失败注解，子进程失败退出码有真实负例保护，不改变 required checks 或测试清单（除显式加入本轮测试）。
- 最近 fetch 的 `origin/main` 仍为本轮固定基线，无需解决代码冲突。**本轮仅提交并开 PR；不合并、不部署、不关闭 issue。**
