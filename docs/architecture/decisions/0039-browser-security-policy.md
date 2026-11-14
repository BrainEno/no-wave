# ADR 0039: 浏览器脚本使用可信 SSR 内容哈希，传输安全只接受原生入口证据

- Status: Accepted
- Date: 2026-11-12
- Scope: Issue #326；React Router HTML、原生 Web 入口、静态资源与浏览器回归

## 背景与取舍

主站已有公开 HTML 的 `s-maxage=60, stale-while-revalidate=300` 与私有页面
`no-store` 隔离。直接把每次请求的 CSP nonce 写进可共享缓存的 HTML，会让
同一凭据被多个访问者复用；把所有 HTML 改成 `no-store` 又会破坏冷启动时的公共缓存。
React Router 的 Scripts、ScrollRestoration、流式数据交接与 React Suspense
还会在 shell 之后继续产生内联脚本，不能只扫描第一个 HTML chunk。

## 决定

1. 生产构建使用强制执行的 CSP，不使用 Report-Only 代替验收。`script-src`
   只允许同源外部模块与可信 SSR 脚本的 SHA-256，不允许脚本 `unsafe-inline`、
   `unsafe-eval`、通配符或外部脚本域；事件属性由 `script-src-attr 'none'` 禁止。
   开发构建保留 framing/object/base/form 基线以兼容 Vite HMR；**生产构建不能
   因运行主机遗漏或错设 NODE_ENV 而进入开发策略**。
2. 每次渲染用 `randomBytes(24)` 创建内部来源标记，同时交给 ServerRouter 与
   React renderer。Router 自行把它传给 Scripts、ScrollRestoration 和 StreamTransfer，
   React 给自己的迟到脚本加标记。标记虽然使用 HTML `nonce` 属性承载，**CSP
   绝不包含相应的 nonce-source**。看见缓存标记并复制到新脚本上，仍不能执行它。
   应用内容不能得到该标记；发现无标记或不同标记的可执行内联 HTML 脚本时拒绝整个文档，
   不能把扫描到的任意脚本都自动加入授权集合。
3. 使用服务器端 `parse5@8.0.0` 的 HTML5 解析语义识别脚本和浏览器规范化后的文本，
   不用正则解析 HTML。注释、raw-text、noscript、template 的惰性内容和 JSON 数据
   不成为脚本授权；相同脚本去重、哈希排序，限制最多 32 个不同授权，防止响应头膨胀。
4. 收集**完整且有界**的 UTF-8 HTML 后才返回 Response。每个文档最多 8 MiB，
   每次 SSR 尝试最多 6 秒，并响应客户端中断；尺寸、解码、生产者或来源校验失败时，
   不能先发部分公开 shell 再补错误。迟到的 React 渲染错误也取消整次尝试，不得把
   等待客户端重渲染的部分 shell 当成公开 200 缓存。Router 的错误重渲染同样经过密封；
   最终失败由原生入口的保守策略覆盖。错误／带 Set-Cookie 的 HTML 必须 no-store。
   `server.ts` 专用于已构建分发包，固定 Router 的 production 错误脱敏模式；主机把
   NODE_ENV 错设为 development 时，终局纯文本 500 也不能泄漏异常消息。
5. 这是明确的 **TTFB／内存取舍**：React 内部仍流式渲染，但浏览器不再提前收到 shell，
   首字节须等到数据交接和 Suspense 完成后；每个并发文档需要有上限的缓冲与解析内存。
   6 秒是异步渲染／收集预算，不是可抢占的同步 HTML 解析 CPU 配额。保留公共缓存，
   不改变 API／feed／媒体等非 HTML 的流式合同，不新增共享服务器 nonce 状态。
6. 文档含 `frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'self'`、
   `frame-src 'none'`、`form-action 'self'`；同源字体、连接和模块保持可用。
   **只有 style** 保留 `unsafe-inline` 以兼容 Lexical 和 GSAP 的属性／CSSOM 修改。
   图片保留现有 HTTPS 外链及 data/blob 能力，不把脚本策略一并放宽；朗读不需要麦克风权限。
7. 原生入口在 health、shutdown 503、坏 URL 400、静态文件、框架／异常处理之前设置
   nosniff、DENY、strict-origin-when-cross-origin 和 Permissions-Policy
   （禁止 camera、microphone、geolocation、payment、usb）。静态／早退响应默认
   `default-src 'none'`；现有媒体／feed 的 sandbox 不得被文档策略替换。

## HSTS 与可信 ingress 合同

HSTS 为 `max-age=31536000`，不擅自加入 includeSubDomains 或 preload。
原生 TLS 是证据；HTTP 的 Host、SITE_URL、Forwarded、X-Forwarded-SSL 或浏览器
自写 X-Forwarded-Proto 都不是。受信入口通过 `WEB_TRUSTED_PROXY_HOPS`（0–5）与
`WEB_TRUSTED_PROXY_PEERS`（明确 IP／窄 CIDR）授权，与地址归属使用相同的链后缀。

每个受信代理必须清洗外部输入，或分别在 X-Forwarded-For 与 X-Forwarded-Proto
**追加它实际观察到的地址和传输协议**。选定访客之后的所有地址都必须是授权代理；
协议后缀必须完整且每项只能是 http/https。选中位置是 https 才启用 HSTS；
未知 peer、不完整链、非法值均不授权。TLS 加密的内部代理连接也不能把访客 HTTP
冒充 HTTPS。该判定不依赖 BFF 地址签名功能是否启用，且异步／嵌套请求隔离。

部署前必须实测入口行为，不支持追加协议的代理应在 TLS 终止层自行设置 HSTS，
不能为了通过探针信任所有 peer。开发 HTTP 不发 HSTS。本轮不改变已有 Secure-cookie
兼容合同、认证／媒体所有权或生产限额，也不解决 #318 的跨副本 refresh 协调。

## 依赖、验收与发布

parse5 是维护中的 MIT、纯 JavaScript／ESM HTML5 parser，直接依赖 entities（BSD-2-Clause）；
只进入 Node SSR，不进入浏览器 bundle。它避免自己实现脆弱的 HTML tokenizer；
运行镜像复制安全模块并安装生产依赖，不依赖 devDependency 或平台服务。

HTTP 验收覆盖公开／私有／404／503、静态 JS/CSS/字体、HEAD／压缩／缓存、伪造协议与
真实受信 socket；真实 renderer 测试覆盖迟到脚本、超限、超时、断连和 shutdown。
所有 Playwright 测试统一使用 CSP fixture，在导航前监听 violation event，保留已导航、
已关闭标签和次要 context 的记录，并逐个检查 HTML 强制策略。只有明确攻击测试可
声明精确的 directive／目标／次数；其他路径要求零违规。上传成功用真实 API、SQLite、
WebP 重编码、AWS S3 适配器和本地 S3 wire fixture，不拿未配置存储的 503 代替成功。

这不是 XSS 修复、全仓安全审计或部署授权。合并以本轮官方 CI 为准；未获单独授权不部署。
