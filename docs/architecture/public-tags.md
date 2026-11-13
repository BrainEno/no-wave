# 公开标签发现与订阅

## 行为、范围与风险

本轮补齐 Phase 4 的标签发现：目录、按名称搜索、详情分页、作品标签回链，以及只读 Atom / RSS 订阅。标签身份来自 API 持久化 slug，不由中文名称反推。

风险为中等：公开内容隔离、XML 转义、上游故障与共享缓存可能导致误发布或误报成功，因此必须验证负面路径。没有新增数据库迁移、身份规则、标签删除／审核政策、通知持久化或生产部署。

## 路由与查询预算

| 资源 | 中文路径 | 英文路径 | 上游读取上限 |
| --- | --- | --- | --- |
| 目录／搜索 | `/tags?q=…&page=…` | `/en/tags?q=…&page=…` | 一次列表，21 行 |
| 详情 | `/tags/:slug?page=…` | `/en/tags/:slug?page=…` | 一次身份＋一次作品页，21 行 |
| Atom | `/tags/:slug/feed.atom` | `/en/tags/:slug/feed.atom` | 一次身份＋一次首作品页，21 行 |
| RSS | `/tags/:slug/feed.xml` | `/en/tags/:slug/feed.xml` | 同上 |

每页只展示 20 行，额外一行只判断下一页。订阅只包含最近的 20 篇，不循环扫描全站，也不承诺归档式完整同步；稀有／很早的作品仍可通过详情分页阅读。空的已存在标签返回 200；不存在或在两次读取间被删除的标签返回真实 404。

React Router 的动态参数必须占据完整路径段，因此订阅路由以 `:feed` 接收完整文件名，再仅允许 `feed.atom` / `feed.xml`。未知格式、无效 slug 在访问 API 前拒绝。

## 可观察验收

- Given 一个包含公开作品和草稿的真实标签，匿名访问目录、详情和订阅时，只有已发布且属于请求 locale 的作品可以出现。
- Given 作者重命名标签，详情链接和订阅身份仍使用原 slug，不制造新身份或猜测另一语言的翻译。
- Given 一次目录翻页，搜索条件保留在 URL；无需 JavaScript 即可搜索、翻页和回到作品。
- Given 标签页，HTML head 公开 Atom / RSS alternate 链接，正文提供可键盘操作的原生订阅链接。
- Given 一个旧 ETag，只有当前完整 XML 仍相同时才能回答 304。上游 404、503、坏数据和超时不能被条件请求掩盖。

## 内容与 XML 边界

订阅从既有匿名 API 读取，不读取浏览器会话，也不透传 Cookie、Authorization 或条件头。作品必须明确为 `published`；若载荷带有 locale，必须与请求一致。缺失 publication 时间不能用 modification / creation 时间冒充。旧载荷可以不带 locale 或 modification 时间，保持既有读取兼容。

`ArticleView.updatedAt` 是可选的公开修改时间，不改变原有 publication 时间或 REST 写契约。Atom 的 entry updated 取已知 publication / modification 的较晚者，feed updated 取当前有限窗口的最大值；空集合使用固定的 1970 年哨兵，不采用渲染时钟。这不是完整集合的变更日志。

标题／作者限制为 200 个 Unicode 标量，摘要限制为 320，频道描述限制为 1000。正文块、作者简介、私有身份信息不被加入订阅。XML 1.0 不允许的控制字符和孤立 surrogate 会变为替代字符，不切断补充平面汉字。

所有文本与属性都转义，不使用用户提供的 HTML、CDATA 或 DTD。Atom summary 明确为 `type="text"`。RSS description 在 XML 解码后可能被阅读器当作 HTML，因此同时转义 HTML 和 XML 两层。RSS 用 Dublin Core creator 发布公开显示名，不要求或暴露邮箱。

链接的 origin 只来自经过验证的 `SITE_URL`，不来自请求 Host、转发头或 API origin；标签／作品身份只能构成站内路径。不能配置带凭据或非 HTTP(S) 的订阅 origin。

## 缓存与失败语义

成功订阅复用 `PUBLIC_PAGE_HEADERS`：`max-age=0`、共享缓存 60 秒、stale-while-revalidate 300 秒。这与公开 HTML 的既有删除／失效窗口一致，并不保证 CDN 中的旧公开内容立即消失；没有生产缓存清理操作。

ETag 基于完整 UTF-8 XML 的 SHA-256，包含重命名、摘要编辑、locale 和格式差异。使用弱 ETag，避免压缩改变 wire bytes 后仍声称强字节等同。GET / HEAD 按弱比较处理完整的 If-None-Match 列表或 wildcard；无效字段不会错误命中。304 不带实体、Content-Length 或 Content-Type。

不伪造 Last-Modified：只知道有限列表中的 publication / modification 时间，无法由它推出标签重命名、移出作品或删除后的集合修改时间。因此仅有 If-Modified-Since 不会触发 304。重验证仍执行当前上游读取，不用进程内旧缓存掩盖删除。

订阅没有查询参数。带查询的请求先 308 到相对规范 URL，避免为无意义参数持续生成共享缓存键。POST / PUT / PATCH / DELETE 返回 405 和 Allow，不触发读取或修改。404／503／405 均为 no-store，503 带 Retry-After；响应不复制上游诊断或秘密。

## 验证与代码入口

- `tag-discovery.ts` / `tag-pages.ts`：身份、URL、Unicode 搜索、分页与有界读取。
- `tag-content.test.ts` / `tag-pages.test.ts`：API 数据形状、截止时间、缺失与故障语义。
- `feed-text.test.ts` / `tag-feed.test.ts` / `tag-feed-source.test.ts`：XML、字符边界、有效日历、公开投影、修改时间、双格式与语言隔离；已进入根 test 入口。
- Web `tag-feed-response.test.ts` / `tag-feed-upstream.test.ts`：条件请求、缺失／故障、凭据隔离，以及 fetch / JSON 两阶段截止时间。
- Web `tag-pages.test.ts` / `tag-feeds.test.ts`：真实生产构建／HTTP 的状态、header、head alternate、分页和预算，不能仅凭单元或构建成功判定可用。
- `e2e/tags.spec.ts` / `e2e/tag-feeds.spec.ts`：临时 SQLite＋真实 API＋生产 Web，检查草稿隔离、XML DOMParser、英文、移动键盘与无脚本入口。
- 上一轮字体预算、完整覆盖与五次不可重试 CLS 守门继续执行，不因增加导航字样而降低阈值。

独立测试进程共用小型 production-Web 启停 fixture，浏览器共用 disposable tag-stack / tag-author fixture；提取的旧 fixture 代码不计作本轮新增实质行。工作开始时已有的标签代码与字体生成产物也不计入本轮新增 800 行。

## 交付边界

真实执行结果、失败记录、精确 head 的 CI / CodeQL 与合并状态以本轮中文 PR 为准。没有部署授权，也不把实现页面等同于全产品、PWA、传统中文路径或主机条件全部验收。
