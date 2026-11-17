# @bot-thk/web-http

框架无关的 Web HTTP 安全边界：标准 Request / Response / Headers 与显式配置。
不依赖 React Router、API domain/persistence 或 PostgreSQL 驱动。

## 先查哪些导出

- `src/index.ts`：公开 handler 和配置/transport 类型；资源路由直接调用。
- `auth.ts`、`account.ts`、`authoring.ts`、`catalogue.ts`：身份、账户、写作与目录。
- `notifications.ts`、`messages.ts`、`comments.ts` 等：共享认证、actor/viewer 和资源代理。
- `forward.ts`：Cookie-only bearer、同 token `/me`、一次协调刷新、轮换 cookies 和 4xx 恢复数据。
- `body.ts`：入站声明/实际字节、严格 UTF-8、浏览器取消与有限等待。
- `upstream*.ts`：响应字节、期限、FIFO 分 lane、熔断、下载背压、固定标签遥测。
- `request-admission.ts`：原生入口的 HTTP exchange / 上传预留预算，不是访客限流。
- `streaming-json.ts`：增量语法检查，保留 O(depth) 状态，不保留整个下载文件。
- `refresh-coordinator.ts`、`session-refresh.ts`：可注入的刷新协议；不确定结果不得重放。
- `client-address.node.ts` / `refresh-runtime.node.ts` / `upstream-runtime.node.ts`：显式 Node 子入口，
  用于原生 ingress 与 SSR 共享上下文；不从浏览器模块导入。

## 使用原则

配置由 app runtime 传入；不要在每个路由创建第二个 transport/coordinator。
没有任意 URL 标签、token cache 或自动 mutation retry；同源、revision、签名计划、
媒体 ownership 与 API 授权不可绕过。容量拒绝是可恢复 503，不是会话失效。

## 验证

```sh
pnpm --filter @bot-thk/web-http test
pnpm --filter @bot-thk/web-http typecheck
pnpm typecheck
pnpm test:web
```

测试在 `test/`；高风险改动先用可观察负例证明旧实现失败，再跑全量和调用者验证。
生产原生 server / Vite / Docker、浏览器与真实 PostgreSQL 的通过不能由单元测试代替。

详见 [BFF 模板](../../docs/architecture/bff-routes.md)、[模块索引](../../docs/architecture/shared-modules.md)、
[上游边界](../../docs/architecture/web-upstream-timeouts.md)及 [ADR 0025](../../docs/architecture/decisions/0025-browser-session-refresh-protocol.md)。
