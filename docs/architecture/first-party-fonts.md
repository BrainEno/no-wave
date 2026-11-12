# 第一方字体分发与性能守门

关联：[#271](https://github.com/BrainEno/no-wave/issues/271)。本轮只改变字体资源的来源、分片、分发和验证，不改变权限、数据、内容发布或生产基础设施。

## 行为与验收

- 四个设计字体家族保持为 Instrument Serif、Inter Tight、Noto Serif SC、Noto Sans SC；Instrument Serif 的 normal / italic 均保留。
- 页面不再声明 Google Fonts 样式表、preconnect 或字体请求。所有运行时字体 URL 都属于当前站点的 `/assets/`。
- 保持 `font-display: swap` 和既有 Georgia、Songti SC、SimSun、PingFang SC、Microsoft YaHei 等平台回退，不用隐藏正文来避免布局偏移。
- 冷上下文中，登录／注册切换累计字体传输严格小于 300,000 字节；代表性中英混排文章严格小于 600,000 字节。计量包含 Resource Timing 报告的响应头开销，不只读取磁盘文件大小。
- 桌面首页 1280 × 720，普通动态效果下五个独立冷上下文，每次最大 CLS session window 均须小于 0.05。五次采样均不可重试，任一次失败就失败本组，不取平均或挑选通过的重跑结果。
- 屏蔽全部第三方 HTTP(S) 请求后，首页、登录页、文章页的实际字体、文本、行框和尺寸不变。

风险为中等：字体失败会影响可读性和排版；不涉及授权、持久化或迁移。验证分为纯策略／离线完整性、实际构建产物、生产 HTTP 和 Chromium 排版测量；不能用源码中的字体名代替浏览器实际用到字体的证据。

## 来源与许可证

`scripts/fonts/font-sources.ts` 固定 Google Fonts 仓库中的五个 TTF Git **blob ID**、对应 SHA-256、四份原始 OFL 文本及其校验和。blob 是不可变内容标识，不把它误称为仓库 commit。下载只发生在显式再生成时，经 GitHub blob API 取得内容，拒绝重定向并校验哈希。构建、测试和页面运行不需要 GitHub 或 Google Fonts 在线。

原始 TTF 不进入 Git 或镜像；`.cache/font-sources/` 仅为可丢弃、校验后使用的构建缓存。仓库提交部署所必需的 WOFF2、原始 OFL、清单和 CSS。字体名称表的版权、许可及许可 URL 保留，字体内部历史名称（如 Thin / ExtraLight）不用于推断 CSS 家族或字重。

`noto-reading-priority.json` 的常用字优先级取自固定 `@fontsource-variable/noto-serif-sc@5.3.1` 的 `unicode.json` 分组，记录原 tarball 和元数据 SHA-256。它只决定分片优先级，不是字形来源，也不从测试文章提取字表。所有其余原始字形仍可按需加载。

Vite 的 `first-party-font-licenses` 插件把四份完整许可证复制到构建的 `font-licenses/` 中；生产镜像与字体一起分发，HTTP 测试逐字验证版权和许可文本。公开地址为：

- `/font-licenses/instrument-serif-OFL.txt`
- `/font-licenses/inter-tight-OFL.txt`
- `/font-licenses/noto-serif-sc-OFL.txt`
- `/font-licenses/noto-sans-sc-OFL.txt`

这些仅是字体许可，不为网站文章重新指定内容许可证。

## 分片策略

直接按 Unicode 编码把中文均分成大块，会使一篇短文请求很多不相关字形；把全部 UI 文字放进每个字体的核心块也会超过登录页预算。因此按**实际字体用途**分层：

| 字体／字重 | 核心与懒加载 |
| --- | --- |
| Instrument Serif 400 normal / italic | 常用 Latin 与标点共享块，其余原始 Latin 字形分片 |
| Inter Tight 400–700 | 常用 Latin 与标点共享变量字体，其余文字按 Unicode 范围请求 |
| Noto Sans SC 400–700 | 外壳／登录文案核心，阅读工具／评论文案独立 interface 块；其余 32 字形叶片 |
| Noto Serif SC 400 | 登录／注册文案核心、公共常用字 reading 块、其余 32 字形叶片 |
| Noto Serif SC 500–700 | 小型展示标题核心、其余 32 字形叶片；不因一个 600 字重标题下载第二份完整 reading 块 |

UI 核心字表来自 `ui-copy.ts` 的外壳文案、站点外壳和登录组件；interface 字表另读阅读工具与评论组件，避免登录页为未展示的阅读界面下载字体。使用已有 Babel 生态的构建期解析器，排除注释与标识符，正确处理字符串转义和模板片段。新 UI 文案改变配方时，离线检查提示重新生成，而不是静默漂移。分片间的 CSS `unicode-range` 不重叠；字体实际 cmap 可保留 HarfBuzz 排版闭包需要的原始映射（例如数学镜像符号），但不能缺少声明的字符或引入上游不存在的字符。

原始非控制字符覆盖为 Instrument Serif 每个样式 333、Inter Tight 2,504、Noto Serif SC 30,928、Noto Sans SC 30,890。清单固定各来源的覆盖数量及排序后码点的 SHA-256，逐个字重检查完整覆盖；不能通过删掉生僻字或遗漏一个字重来让预算通过。

这是按需分发，不是承诺任意长度、任意生僻字密度的用户文章都只需固定字节数。600 KB 守门有明确的中英混排正文 fixture；异常大的字符集合仍会加载更多合法分片。完整字体集合的仓库体积与首屏传输量是不同指标。

## 生成与离线验证

使用仓库固定的 Node 24、pnpm 10.20.0 和 lockfile：

```sh
pnpm install --frozen-lockfile
pnpm fonts:generate       # 显式下载不可变上游输入并生成；首次需 GitHub 网络
pnpm fonts:check          # 不联网、不重新子集化，验证全部已提交产物和当前配方
pnpm test                # 包含离线字体策略、负例与完整性测试
pnpm test:web            # 先构建，再核对真实 CSS、哈希资产和许可证 HTTP 分发
pnpm test:e2e --grep 'font|typography|cold desktop home'
```

构建期工具为精确版本 `fontkit@3.0.0`、`subset-font@2.9.0` 和 `@babel/parser@7.29.11`，不进入应用运行时或浏览器 JavaScript。解析器复用原 lockfile 已有版本，不降低既有 Babel 工具链的传递版本。子集保留 OpenType 排版功能；不通过删除字形替换、提示信息或断言来换取更小数字。

生成先写入临时目录，完成字形、格式、哈希、来源、许可证和分片检查后才替换原产物。源下载或子集化失败时，不发布半套新字体。源码、字体、清单、CSS、许可证必须一同审阅提交；生成的元数据／二进制不计入本轮实质代码行数。

Vite 将 CSS 中所有字体 URL 改写为同源带哈希资产，连小分片也不内联到全局 CSS。生产服务器沿用既有 `font/woff2`、HEAD、Content-Length 和一年 immutable 资源缓存；不另设字体代理或第三方回源。原始许可文本按普通静态文件重验证缓存。

## 回归证据与失败诊断

- `scripts/lib/font-assets.test.ts`：恶意路径／CSS 值、无效 Unicode、分片重叠、完整覆盖、丢失字重、变更字节、损坏 WOFF2、许可证缺失和配方漂移。
- `apps/web-rr/test/font-build.test.ts`：实际构建 CSS 的每个 face 必须指向存在、内容与清单相符的哈希 WOFF2；不能退化为 data URL、系统字体、外部 URL 或不可达资产；生成器不进入客户端。
- `apps/web-rr/test/server-lifecycle.test.ts`：生产分发携带原始许可文本，不只在仓库里存在。
- `e2e/fonts.spec.ts`：冷传输预算、字体状态、CDP 实际绘制字体、normal / italic 和必需字重、五次普通动态 CLS，以及屏蔽第三方后的几何与字体一致性。

浏览器在初始化时安装 CLS 观察器，按最大 session window 计量，排除最近输入；不支持测量的浏览器不能以零值通过。先等待评论真实 hydration／加载完成，再在 15 秒上限内等待字体事件静止和 `document.fonts.ready`，避免漏算异步 UI 字体；不以与字体无关的 view beacon 或全局 `networkidle` 代替字体就绪。性能用例使用独立临时数据库、真实 API 和同一生产构建，避免其他旅程刚创建的推荐作品污染固定预算；不 mock 或截断文章响应。

字标保留原字体、字距和逐字动效，以固定行框和所选字体的 advance 预留字槽，同时只预加载外壳实际使用的两个 Latin 核心块。延迟第一方字体的桌面／移动端回归验证换字前后几何不变，文字仍可见。普通动效测量另在有界窗口内等待幕布移除及逐字 transform 真正归位；软件 GL 下 GSAP 虚拟时间不等于墙钟时间，因此不能用固定短睡眠假定动画已完成，也不为此放宽字体加载期限或 CLS 阈值。预算、CLS 和屏蔽第三方的读数附到 Playwright 报告，保留失败尝试；不降低阈值、不跳过检查来取得绿色。

实际运行结果以当前 PR 的精确 head CI / CodeQL 及其报告为准。历史轮次的绿色不能验证新字体产物，也不代表部署授权。
