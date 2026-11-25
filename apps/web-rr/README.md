# Web 应用（React Router Framework Mode）

唯一运行中的 Web 应用；框架选择见 [ADR 0012](../../docs/architecture/decisions/0012-portable-web-framework-migration.md)
与 [0017](../../docs/architecture/decisions/0017-nextjs-retired-one-web-application.md)。版本以 package.json 为准。
共享界面在 `packages/web-ui`；API 的业务、持久层及授权不搬进 Web。

## 入口与目录

- `server.ts`：原生 Node 24 HTTP、静态文件、SSR、安全 headers、探针与有界关停。
- `app/routes.ts` / `app/routes/`：页面 loader/action 和资源路由；BFF 直接 import web-http。
- `app/lib/runtime.ts`：唯一应用配置适配层；显式注入 API/site/mail/source/transport。
- `upstream/`：单进程上游容量、原生 intake、受保护压力指标；`upstream-ingress.ts` 接 Vite。
- `refresh/`：单实例内存 / 可选多实例 PostgreSQL 刷新 ledger，仅服务端加载。
- `operations/`：禁用为默认的运维 endpoint 保护；不属于访客认证 API。
- `public/`：一方静态素材；字体版权由构建校验。
- `test/`：生产 build、真实 HTTP、生命周期与共享刷新验证。

`/write/merge` 是可匿名打开的本机三方文稿工具空壳，不是服务器合并端点；
使用统一私有响应头并移除查询参数，文件读取/取舍都由共享 UI 在内存中执行。
见[操作说明](../../docs/operations/writing-merge.md)。

## 开发与验证

从仓库根目录：

```sh
pnpm setup:local
pnpm db:migrate
pnpm dev
pnpm --filter @bot-thk/web-rr typecheck
pnpm test:web
```

`pnpm dev` 监督 API、通知 worker 和 Web；不要把 Web 当成一体式后端。
`pnpm test:web` 先 build，再运行原生生产服务器测试。
真实多 Web / PostgreSQL 测试需要隔离 `TEST_DATABASE_URL`，本地 skip 不能算验收。

## 配置和边界

根 `.env.local` 与 shell 显式注入，shell 优先；见 [环境模板](../../.env.example)。
旧的 GraphQL 时代与 Next.js 时代的兼容名已移除（#350），不再读取；见根 README。
保留 `API_SERVICE_URL`（平台服务绑定）。`RR_BUILD_DIR` / `RR_SERVER_BUILD_DIR` 只改产物位置。

写新资源前先读 [BFF 模板](../../docs/architecture/bff-routes.md)与[公共模块索引](../../docs/architecture/shared-modules.md)。
上游限制见[期限与压力边界](../../docs/architecture/web-upstream-timeouts.md)；
共享刷新见[运维规程](../../docs/operations/web-refresh-coordination.md)。
Web 直连 PostgreSQL 只限 ADR 0025 的短期协调结果/长期防重放 fence，不存 API 业务行。
