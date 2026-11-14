# 公开站点地图与爬虫资源

本页描述代码与测试中的读取契约，不代表已经部署或完成生产搜索引擎验收。

## 收录范围

`/sitemap.xml` 为 `zh-CN`（无前缀）与 `en`（`/en`）发布：

- 首页、作品目录、作者目录、分类目录、标签目录；
- 匿名公开作品、独立作者目录中的作者、分类详情、标签详情。

身份始终使用存储的 slug／作者 ID，不从显示名称推导。作者扫描独立于
作品扫描，因此作品窗口外的作者仍可由作者目录发现。作者目录由 API
限定为在请求作品 locale 有已发表作品的作者；作者资料的文字可以沿用
API 既有的 `zh-TW` 等翻译回退，不会据此臆造另一个作品 locale。

不收录登录、账户、写作台、私信、搜索查询、任意分页、Atom／RSS 地址。
空分类／空标签的详情页本身仍是公开可浏览的页面，可以收录；没有作品
locale 翻译的身份不会通过一个 locale 的扫描复制到另一个 locale。

## 有界读取，不是全量历史导出

- 每种目录、每个 locale：每页最多 **100** 行，最多 **50** 页；
  offset 为 `0..4900`。四种目录、两个 locale 最多 **400** 次顺序读取，
  同时只发出一个目录请求，不执行每条详情查询。
- 每个 API 响应最多读取 **8 MiB 解压后的字节**，不信任 Content-Length；
  JSON、UTF-8、公开状态、locale、身份与必要时间字段必须满足读取契约。
- 一次地图构建的默认总期限为 **15 秒**；每个 API 读取还受既有
  `API_TIMEOUT_MS` 约束。总期限取消信号会传到正在进行的读取，迟到的
  返回值不能继续启动下一页。
- 短页停止该目录。达到 50 页时发布该目录的有界窗口，不额外发第 51 页，
  **不保证所有历史作品或超过 5000 名作者／分类／标签均被收录**。
- 跨页重叠会去重并保留较新的真实修改时间；同页重复身份、满页不前进、
  坏行、超大页或任何一页失败都使本次构建失败，不发布半张成功地图。
- 最终 XML 仍独立执行 Sitemap 协议的 50000 URL／50 MiB 上限，以及
  单 URL 长度、HTTP(S)、XML 字符、日期、priority、changefreq 校验。

目录规模超出窗口时，应另行设计 Sitemap index／分片或后端专用分页契约，
不能移除当前请求预算或声称本实现是完整归档导出。

## 配置与隐私

`SITE_URL` 优先；未设置时兼容 `NEXT_PUBLIC_SITE_URL`。空配置保留
`https://example.invalid` 占位行为。只使用合法 HTTP(S) origin：规范化
主机与默认端口，丢弃路径、查询和 fragment；拒绝凭据、控制字符、相对 URL
与其他协议。异常消息不包含被拒绝的配置值。

绝不从请求 Host、Forwarded、X-Forwarded-Host 或 API origin 生成公开身份。
API 读取只带匿名 JSON Accept 头，`credentials: omit`、`cache: no-store`、
禁止跟随重定向；不转发 Cookie、Authorization 或客户端条件请求头。

没有配置 API 时才显式使用本地作品 fixture；配置过的 API 不可用时不会
回退到 fixture 或伪装成空目录。普通读者页面的既有兼容 mapper 不变。

## HTTP 与缓存

两种资源共享响应策略：

| 情况 | 行为 |
|---|---|
| GET | 200、正确 MIME／UTF-8、完整正文的 SHA-256 弱 ETag、字节长度、nosniff |
| HEAD | 与 GET 相同的实体头，不发送正文；地图仍需读取当前目录 |
| 有效 If-None-Match 命中 | 重读并成功生成当前表示后返回无正文 304；不发送 Content-Type／Content-Length |
| 单独 If-Modified-Since | 不据此返回 304；没有完整目录修改时钟，不伪造 Last-Modified |
| 带 query 的资源 URL | 308 到固定的同源相对资源路径，不读 API，不反射 query |
| 不支持的方法 | 405、Allow: GET, HEAD、no-store，不读 API |
| 无效配置／上游故障／坏契约 | 通用文本 503、Retry-After: 60、no-store、noindex；没有 ETag、内部错误或部分 XML |

成功与 304 使用既有公共页策略：浏览器 `max-age=0`，共享缓存
`s-maxage=60, stale-while-revalidate=300`；没有进程内响应缓存。下架后
新的 origin 请求会重读，但共享缓存仍可能在上述窗口内提供旧副本，
**不承诺 CDN 即时下架**。robots 不依赖 API，即使地图暂不可用仍可访问。
原服务器压缩白名单保持 HTML／JS／CSS，不在本次扩大；弱验证器也允许
下游缓存做编码变换而不把编码当成另一个内容身份。

## 回归证据入口

- [目录与严格读取](../../packages/web-ui/src/lib/sitemap-catalog.test.ts)
- [扫描预算、独立作者发现与排序去重](../../packages/web-ui/src/lib/sitemap-discovery.test.ts)
- [origin 与 XML 协议](../../packages/web-ui/src/lib/crawl-origin.test.ts)
- [响应语义](../../apps/web-rr/test/crawl-response.test.ts)
- [真实 production HTTP 与可控故障 API](../../apps/web-rr/test/crawl-resources.test.ts)
- [真实 SQLite／REST／production Web 的公开与撤回链路](../../apps/web-rr/test/crawl-publication.test.ts)

前三项接入根 `pnpm test` 的显式清单与 inventory guard；Web 项由
`pnpm test:web` 的正常 glob 执行。字体、私有缓存、权限、标签治理与数据库
写入策略未因这些公开读取而更改。
