# @bot-thk/web-ui

共享 React 视图、交互状态和可移植的内容/元数据 helpers；不持有 Node 环境配置、
数据库、JWT 内部实现或 server secrets。Web 应用的适配在 `apps/web-rr`。

## 目录与优先入口

- `src/components/ui/parts.tsx`：基础控件和共享交互；`src/lib/ui-copy.ts`：已有通用文案。
- `src/lib/framework/`：唯一导航 seam；其他组件不自行绑定第二套路由实现。
- `src/lib/api-content.ts`：显式 client/source，API URL 的纯解析与响应映射。
- `src/lib/public-pages.ts`、`tag-pages.ts`：页面数据需求与有界读取，不负责读取环境。
- `src/lib/tag-feed.ts`、`site-metadata.ts`、`sitemap-catalog.ts`：feed/SEO/crawl。
- `src/lib/mail-feature.ts`：显式 mail switch；app loader 把布尔值传给页面。
- `src/lib/writing-*.ts`、`authoring-catalogue-*.ts`：写作、目录、集合、导出和修订恢复。
- `src/lib/notification-*.ts`、`messaging-*.ts`：浏览器传输和状态控制，保留取消/身份切换保护。
- `src/styles/`、`src/data/`：共享呈现与明确无 API 模式的示例内容。

## 配置契约

`apps/web-rr/app/lib/runtime.ts` 将 API endpoint、site origin、mail、source、
request signal 和共享 transport 注入；此包不读 `process.env`。
默认 fixtures 只适用于明确没有配置 API 的模式；已配置 API 报错不得悄悄回退。
浏览器模块不能导入 `@bot-thk/web-http/*-runtime` 的 Node 入口。

## 验证

```sh
pnpm --filter @bot-thk/web-ui typecheck
pnpm test
pnpm test:web
pnpm test:e2e
```

纯 helper 的测试与实现相邻，并由根 `pnpm test` 执行；TSX/SSR 的最终行为由生产
Web 和 Playwright 覆盖。修改配置接缝要同时验证无 API fixtures、已配置 API 成功/
失败、mail off/on、locale、canonical、feed 和 sitemap，不污染全局环境来伪造来源。

新功能前读[公共模块索引](../../docs/architecture/shared-modules.md)；HTTP 行为读
[web-http](../web-http/README.md)，应用接线读 [web-rr](../../apps/web-rr/README.md)。
