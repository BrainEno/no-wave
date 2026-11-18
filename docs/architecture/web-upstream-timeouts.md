# Web 上游期限、容量与下载边界

此页覆盖原有 F-17 期限保护和新的 Web/BFF 资源边界，不是部署或放宽 API 业务限额的授权。
API 继续负责授权、媒体归属、revision、签名 import plan、每作品原子性及持久化。
见 [BFF 模板](bff-routes.md)、[模块索引](shared-modules.md)、[ADR 0025](decisions/0025-browser-session-refresh-protocol.md)。

## 1. 一个进程、一个 transport

原生 `server.ts` / Vite ingress 创建进程级 `UpstreamTransport`，通过 Node
AsyncLocalStorage 注入 SSR、BFF、媒体与 crawl。`app/lib/runtime.ts` 显式构造
API/site/mail/source；共享 UI 不读取环境。SSR 将 HTTP 主入口和 Node store 保持
external，确保错误类身份与请求上下文不因打包而复制；否则容量 503 会误变成网络 502。
没有请求上下文的原生脚本使用一个有界 fallback，不为每个 loader 新建容量池。

未配置 API 时保留明确的 fixtures 模式；配置无效、API 故障或返回损坏资料时失败关闭，
不能回退 fixtures 冒充线上内容。`API_BASE_URL` 优先于旧 `API_GRAPHQL_URL`，后者去掉
`/graphql` 并告警，再到 `API_SERVICE_URL`；站点旧 `NEXT_PUBLIC_SITE_URL` 同样保留。
移除部署别名仍须 owner 确认。

## 2. 时间与入站预算

| 边界 | 默认 / 上限 | 行为 |
| --- | --- | --- |
| 普通上游调用 | 10,000 / 120,000 ms | `API_TIMEOUT_MS`；排队、连接、headers、整个 body 共用绝对期限 |
| Notion import | 未设置 override 时仍为 90,000 ms | 保留历史行为；显式 `API_TIMEOUT_MS` 优先，不改上传/import 限额 |
| handler 入站 body | 30,000 ms | 声明/实际字节与长度一致性检查、严格 UTF-8、客户端 signal；超时私有 408，取消 499 |
| 原生 HTTP 完整入站消息 | 60,000 ms；1,000–120,000 | `WEB_REQUEST_TIMEOUT_MS`；不是 API 完成/响应写出的总期限 |
| 原生 HTTP headers | 15,000 ms；1,000–120,000 | `WEB_HEADERS_TIMEOUT_MS`，不得超过入站消息期限 |
| 原生 keep-alive | 5,000 ms；100–60,000 | `WEB_KEEP_ALIVE_TIMEOUT_MS`；Node 每 1,000 ms 检查未完成入站连接 |

明确设置的空值、非整数或越界值失败关闭，不静默 clamp 或变成无限等待。
Node 的连接检查有检查周期误差；handler 的 body deadline 独立于该周期。
body 的 30 秒预算不包含随后进行的 90 秒 import；不会把合法长 import 压成上传期限。

期限使用单调时钟 checkpoint：计时器尚未得到执行机会也不能把超期工作当成功，
更不能在过期队列获准后才发送 mutation。下载读取/验证后、向下游 enqueue 前再次检查。
缓冲与入站循环也逐次检查，已 resolve 的连续空 chunk 不能靠微任务饿死计时器。
这不是 JavaScript 的硬实时／CPU 抢占保证；同步工作不能被计时器强制打断。
浏览器取消与期限分别标记；任何 signal/异常的原始 reason 都不回传。
注入 fetch 即使忽略 abort，调用者也按时返回；真实 fetch 未结束仍占物理槽。
取消 body 不等待不合作的 `cancel()`，但其未完成 receipt 继续占槽与恢复 probe，
直到源确认取消；关停只按有限预算等待，不能假装资源已释放。
异常 fetch 适配器若交回已被其他 reader 锁定的响应，无法取得读锁或取消凭据时同样保留
未知物理所有权：调用者收到脱敏错误，active/detached/cancelling 仍非零，drain 返回 false。
锁冲突产生的立即拒绝不是源取消确认；不能靠超时回收这个槽。须修复适配器并替换该
transport／进程，不能把另一个 reader 的存活流当作已排空。原生 fetch 的新响应不预锁。

## 3. 两层容量，不把请求内存藏在上游队列前

原生 intake 在应用读取 body 前预留容量，持有到输入和响应都结束，而不是仅到 body
接收完毕。已声明长度按字节预留；chunked 按最大合法入站 body 全额预留。
HTTP framing 歧义、GET/HEAD 带非空 body 在运行应用前拒绝；实际路由小限额照旧。

| 进程内 lane | 默认 active / queued / 排队期限 | 设置 |
| --- | --- | --- |
| intake ordinary | 56 exchanges，无内存队列；64 MiB body reservations | `WEB_REQUEST_CONCURRENCY` 1–256；`WEB_REQUEST_BODY_BUDGET_BYTES` 9–128 MiB |
| intake session | 独立 8 exchanges / 4 KiB 各自预留 | 仅匹配 auth 路由及 session GET；无关路径的 query/相似前缀不能借用 |
| upstream data | 8 / 32 / 250 ms，FIFO | `WEB_UPSTREAM_CONCURRENCY` 1–32；`WEB_UPSTREAM_QUEUE` 0–128；`WEB_UPSTREAM_QUEUE_TIMEOUT_MS` 1–5,000 |
| upstream auth | 独立 2 / 8 / 250 ms | 登录/刷新等 auth 和同 token `/me`，不会排在普通大读取后 |
| upstream bulk | 独立 1 / 2 / 250 ms | Notion export；不借用 data/auth 槽 |

intake 满载返回私有 `503 WEB_BUSY`，关闭该连接；上游满载/排队到期/关停/熔断返回
`503 UPSTREAM_BUSY`。有归一化 Retry-After（本地拒绝 1–30 秒），不清除会话。
它们是每进程保护，不按账号/IP 限流，也不是跨副本的全局速率保证。
提高并发要重新审核多份字节 buffer、解码字符串、JSON 对象及 SSR 的内存成本；
64 MiB reservation 是入站原始字节预算，不是整个 Node 进程 RSS 上限。

## 4. 响应与 bulk

- 普通 API/content/crawl 缓冲最多 8 MiB decoded bytes；auth 最多 64 KiB。
  媒体仍使用既有 8 MiB 上限。无编码或 identity 的声明长度先拦截，实际 decoded bytes 再检查。
  原生 fetch 解压后仍保留压缩前 Content-Length，编码响应不能把该值当 decoded 长度。超量返回脱敏 502，不悄悄截断成功资料。
- JSON 使用 fatal UTF-8 与 JSON 语法验证；提供 Content-Type 时必须是 JSON 媒体类型，
  不把 HTML success 透传成浏览器文档。401 的可选诊断 body 无效时使用固定私有错误，
  仍按状态执行一次协调刷新；不能因空 body 吞掉轮换机会。业务 4xx 恢复字段保留。
- 5xx 只返回固定安全错误，不回传 driver 文本、Set-Cookie、stack 或原始异常。
  headers 仅按用途白名单重建，Retry-After 通过既有解析器归一化。
- `api/v1/imports/notion/export` 使用 demand-driven stream（输出 HWM 0），
  不 `text()` / `clone()` 整个成功附件；EOF 前一直持有 bulk 槽与绝对期限。
  非成功响应不是大文件，最多 64 KiB。下载开始后出错只能中止 body，不能重写已发的状态。
- bulk 的新 **stream-only** decoded 字节 fence 是 2 GiB，不允许走缓冲接口。
  它高于当前 Node 24/V8 可一次生成的 JSON 字符串的最坏 UTF-8 体积，避免用任意
  64/256 MiB 小缓冲上限误砍合法 50 作品／100 语言页；真实映射的大型回归超过 512 MiB。
  `MAX_EXPORT_WORKS=50`、文章字符、8 MiB bundle/import、媒体所有权和签名/原子性均未放宽。
  这也不宣称任何大小的导出都能重新导入同一个 8 MiB 请求；既有导入限额继续拒绝超量。
- 成功附件增量检查 JSON 语法与 UTF-8；保留状态为 O(depth) 加当前 decoded chunk，
  默认最多 128 层（构造允许 1–256），不保留 keys、值或整棵对象树。
  这不是 import schema/签名验证，不宣称对任意不可信 bundle 完成业务验收。

### 4.1 合法文章集合例外（#366）

普通缓冲仍为 8 MiB，不用扩大该值承接整页全文。公开文章、作者/分类/标签作品、精选、
相关作品以及 BFF 的既有作者/收藏/关注流集合，使用受限的增量 envelope：默认至多 100 项，
由路由合法 limit 收紧；仅作者多语言集合可到 300 项。每项至多 8 MiB decoded bytes，
非 item 的 envelope 累计至多 64 KiB；因此总字节 fence 从项数推导，不使用 bulk lane。
非法参数仍由 API 拒绝，不用 fallback、减少行数或丢正文换取成功。

解析器逐项 JSON.parse 和投影，fatal UTF-8、完整 JSON、唯一 envelope key、项数/字节和 EOF
全部成功才暴露结果。失败清空结果，不返回“前几项成功”。复制的 64 KiB 惰性 slabs 防止
一字节碎片制造数百万数组对象，也避免适配器复用 Buffer 后篡改已捕获字节。
flatten 时仍有一份额外紧凑副本；解码字符串、JSON 对象与调用者保留的结果另计，
这不是 Node RSS 上限或 full 客户端零内存保证。

SSR 显式请求 `view=card`；API 返回 `contentProjection=card` 与 `reading`，省去正文但保留
阅读长度及第一段前两条非空诗行。SQLite iterate / PostgreSQL 单行 callback cursor 先投影再
保留下一个结果；取消检查在行之间让出事件循环。PG callback 模式等待驱动游标收尾并移除
abort 监听器。默认/full 客户端、详情与写作读取仍是全文；不能拿 card 冒充 detail。
归档、作者、标签 feed 和 sitemap 使用 card，语言、顺序、分页、公开性和真实修改时间不变。

API 原生服务另有文章 GET 集合容量池：默认 4 active / 16 queued / 250 ms 排队；
`API_COLLECTION_CONCURRENCY` 1–32、`API_COLLECTION_QUEUE` 0–128、
`API_COLLECTION_QUEUE_TIMEOUT_MS` 1–5000。满载/排队到期返回私有 `503 COLLECTION_BUSY`、
Retry-After 1；身份、health、detail 和所有 mutation 不经过该池。
槽须等 handler 与 native response **都**结束：客户端先断开、持久层未确认结束时，
`api_http_collection_detached` 保持非零，不能靠超时创建无限替代查询。关闭服务拒绝队列，
不伪称未知数据库工作已结束。该池不是跨实例全局限流或全页内存预留。

获得槽之后的初始读取与 batched metadata 还有独立读取期限：
`API_COLLECTION_READ_TIMEOUT_MS` 默认 120000，范围 100–600000 ms，显式空值拒绝启动。
超时在 headers 前回答私有 `504 COLLECTION_READ_TIMEOUT`，并中止合作的 card cursor；
未合作的 DB 工作仍占 active/detached 槽，直到真实结束。读取返回后的 checkpoint 禁止再启动
文章/metadata 查询。并发 metadata 或多语言读取即使一项先失败，也等待所有已启动分支 settle，
不以 `Promise.all` 的提前 reject 假装物理资源已归还；保持原输入顺序、原始首个失败且不重试。
这只覆盖集合 GET，独立于身份、详情、mutation 和后续 writer 的期限；同步 CPU 仍不可抢占。

API writer 输出至多 64 KiB 一块，等待 drain 后才继续遍历下一项；单项 8 MiB、envelope
64 KiB 的生产 fence 同样检查实际 UTF-8，未提高任何文章/导入业务限额。
`API_COLLECTION_WRITE_TIMEOUT_MS` 默认 120000、范围 100–600000 ms，只覆盖编码、drain 与
finish，不包含之前的 DB 获取；既有 API 入站和 Web 上游期限独立。超时/编码错误若发生在
headers 前由既有脱敏错误策略回答；headers 后 destroy 不完整 JSON，不能补第二个 envelope。
该保护是协作式 checkpoint，不承诺抢占同步 getter/编码 CPU。

BFF 在确认合法 `data` 数组前只预读至多一个 envelope 加一块 64 KiB segment，避免仅有
headers 或停滞前缀就提交成功。之后 HWM 0、按需求重放/转发；晚期 EOF 错误只能中止流。
逻辑期限和真实取消 receipt 仍由原 transport 管理；不新增 mutation retry。

新增固定标签指标包括 `web_upstream_collection_*` 的 parsed/forwarded、items、envelope、
validated EOF、最大 item 与捕获峰值，以及 API 的完成/取消/失败、实际 accepted bytes、chunks、
drain 等待与 writer duration。native finish 不是对端已消费全部字节的证明；writer duration
不是 DB 端到端耗时。所有指标不包含正文、账号、URL 或错误原文。

## 5. 固定 lane 熔断与重试边界

每 lane 连续 5 次网络/期限/损坏响应/5xx 失败后开启，默认冷却 2 秒。
健康 2xx–4xx 重置失败数；调用者取消是 neutral。恢复只允许一个 half-open probe；
旧 generation 的迟到成功/失败不能关闭或重新开启新一代熔断。不发自动 probe 请求。
物理 probe 即使已逻辑超时，也等真实 fetch/body 结束或取消确认后才释放独占权。

**没有自动 mutation retry。** 唯一既有例外是收到 401 后一次协调刷新，再以新 token
重试一次，并重查 actor。轮换成功后资源超时/失败也保留 rotated cookies。
取消一个等待者不取消其他人共用的一次性刷新。API 可能在 Web 超时后已提交，
所以超时不是“没有写入”的证据；幂等键、revision 和后端授权仍必需。

## 6. 运维端点

`/internal/upstream-metrics` 默认 404；只有独立 `WEB_UPSTREAM_METRICS_TOKEN`
才启用。凭据为 43–128 个 URL-safe 字符，不得与 refresh metrics、AES、JWT 或
来源证明密钥共用。仅 Authorization Bearer；无 query；GET/HEAD；授权后每分钟
60 次；最多 32 KiB；no-store/noindex。生产原生 server 提供该端点，Vite 不发布它。
仍应在代理限制为运维网络，不在浏览器或 URL 放 token。既有 refresh 端点保持独立。

失败样本保留已观察到的 HTTP class 和已接收且通过字节 fence 的 decoded bytes；被拒绝的 chunk 不计入。
固定 label 仅 kind/outcome、lane、HTTP class 和固定 histogram bucket；不含 URL、
路径、账号、文件名、异常、token 或 body。关注：

- `web_upstream_requests_total`、response bytes、HTTP class、duration；
- active / queued / capacity、最老真实操作年龄与实际 admission wait histogram；
- detached / cancelling 槽数和最老阶段年龄，区分还在服务读者、调用者已结束和取消未确认；
- source cancellation 的 acknowledged / rejected 次数及确认等待总时长；重复 cancel 只计一个物理操作，拒绝原因原文不入指标；
- circuit one-hot state、失败数、剩余冷却；冷却 0 不代表可以绕过仍占槽的 probe；
- `web_intake_*` active、原始 body reservations、peak、拒绝原因、完成类别与 draining。

抓取只读内存，不发 API/数据库请求。counter/gauge 都是单进程值；不能把一次逻辑
超时误认为物理 active 已归零。`/healthz` 不探测 API，`/readyz` 的依赖语义仍见
[刷新运维](../operations/web-refresh-coordination.md)，不宣称这些指标完成了公网托管资格验证。
SIGTERM/SIGINT 停收后复用原 8 秒预算排空，真实未排空返回失败，不另加无限 cleanup。

## 7. 验证入口

```sh
pnpm --filter @bot-thk/web-http test
pnpm typecheck
pnpm test
pnpm test:web
pnpm test:routes
```

`upstream-{boundary,transport,circuit,stream,pressure,release,clock,encoding}.test.ts`、
`request-{admission,body-deadline}.test.ts`、`streaming-json.test.ts`、
`notion-export-boundary.test.ts`、`refresh-cancellation.test.ts` 验证资源边界；Web 的 `upstream-runtime.test.ts`
使用实际生产 bundle 验证共享 runtime、503 类别、auth 隔离、取消与运维计数。
既有 API import/media/revision、安全浏览器与跨 Web 刷新测试不得削弱。
本地跳过真实 PostgreSQL 不是通过；required CI 的真实库、双 Web、容器与浏览器
检查，以及独立行数/冲突审查仍须逐项报告。此页本身不是这些检查通过的证据。
