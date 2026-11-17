# BFF 路由：一个 handler，一次安全决策

`apps/web-rr/app/routes/api.*.ts` 直接导入 `@bot-thk/web-http`；
框架只传递标准 `Request`、路由参数及 `apiProxyConfig()`。历史四个
`app/lib/*-proxy.ts` 是配置包装，不是第二个业务边界，已移除。
配置与共享状态在原生入口注入，不能在每个路由新建 transport / coordinator。

## 最小模板

```ts
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringArticleRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

export function loader({ request, params }: LoaderFunctionArgs) {
  return handleAuthoringArticleRequest(request, { id: params.id ?? "" }, apiProxyConfig());
}
export function action({ request, params }: ActionFunctionArgs) {
  return handleAuthoringArticleRequest(request, { id: params.id ?? "" }, apiProxyConfig());
}
```

只提供资源实际支持的 loader/action。只读路由的写入拒绝也复用共享 handler，
不得为避开方法检查自行转成 GET。新增路由同时登记 `app/routes.ts`。
不要转发浏览器自写的 `Authorization`、身份 ID 或 `X-Forwarded-*` 当作可信凭据。

## 检查顺序与责任

1. **原生入口资源保护**：HTTP headers/request timeout、intake 併发与字节预算。
   此层只控制容量/HTTP framing，不判断业务权限；失败不运行应用。
2. **共享 handler**：方法，再验证写入的精确同源 Origin；然后校验路径与 query，
   以及有界 JSON / 二进制 body。敏感路由先拒绝跨源，避免暴露 ID 是否存在。
   具体只读/认证端点的既有顺序以对应 handler 的回归测试为准。
3. **可信会话**：只从 HttpOnly cookies 建立上游 bearer。需要 actor/viewer
   预条件时，用与资源相同的 token 请求 `/me`，不接受浏览器身份声明。
4. **上游边界**：显式 API 地址、绝对期限、FIFO admission、固定 lane 熔断、
   字节/UTF-8/JSON 验证。Auth 与 bulk 不借用普通容量；无自动业务写入重试。
5. **401 的唯一例外**：参与一次协调刷新，最多以新凭据重试一次；必须重新检查
   actor。一个等待者取消不撤销其他请求共用的刷新。不确定结果不裸重放。
6. **API / 数据库**：最终授权、revision、签名 import plan、每作品原子性与媒体
   ownership 仍在后端执行，BFF 检查不是替代品。
7. **返回浏览器**：私有 no-store，归一化 Retry-After，不泄露 token/原始 5xx。
   业务 4xx 的修订与导入恢复资料保留；刷新成功后资源失败也必须附带已轮换 cookies。

成功 Notion 下载使用受限串流，EOF 前一直拥有 bulk 槽和期限。开始发送后再发现
损坏 JSON、超量或超时，只能中断下载，不能把已经发送的 200 换成错误 JSON。
附件文件名与 header 由本层指定，不信任上游文件名或 framing。

## 最小验证矩阵

- 方法、Origin、非法参数/UTF-8、声明/实际超量、慢 body、客户端断开。
- Cookie-only、同 token actor、401 后一次刷新、轮换后失败仍保留 cookies。
- 无 API 配置和错误配置、网络/5xx/熔断/满载、4xx 恢复数据、Retry-After。
- 下载背压、未消费响应、绝对期限、取消和大体积合法 bundle。
- 运行 `pnpm --filter @bot-thk/web-http test`、`pnpm typecheck`、
  `pnpm test:web`；跨 Web 刷新仍须真实 PostgreSQL 和独立 OS 进程的 required CI。

另见[模块索引](shared-modules.md)、[上游运维边界](web-upstream-timeouts.md)、
[ADR 0025](decisions/0025-browser-session-refresh-protocol.md)。
