# BOT THK —— 新产品实现

> **语言 / Language:** **简体中文** · [English](./README.md)
>
> 两版内容同步维护；若翻译与源码或英文原版有歧义，请以源码及 [English](./README.md) 为准。
>
> 第一次使用？直接看[快速开始](#quick-start)，或阅读完整的[本地开发](#local-development)说明。

本仓库是 BOT THK Web 与 API 产品的独立实现。旧项目只作为功能与行为参考，不需要保留或照搬其代码。

## 目录

- [快速开始](#quick-start)
- [产品与工程方向](#product-and-engineering-direction)
- [当前实现状态](#current-implementation-status)
- [环境要求](#prerequisites)
- [持久化运行时与部署建议](#persistence-runtime-and-deployment-guidance)
- [可观测性](#observability)
- [本地开发](#local-development)
- [其他检查与命令](#other-checks-and-commands)
- [PostgreSQL 集成测试](#postgresql-integration-tests)
- [数据库与 URL 配置参考](#database-and-url-configuration-reference)
- [CI](#ci)
- [术语说明](#lexical-note)

<a id="quick-start"></a>
## 快速开始

日常开发请**优先使用本地数据库**。这条路径不需要 Docker，也**不会消耗 Neon 额度**。

```sh
corepack enable                    # 只需一次；当 pnpm 不在 PATH 时执行
pnpm install --frozen-lockfile
pnpm setup:local                   # 生成 .env.local：SQLite + 随机的 JWT secret
pnpm db:migrate                    # 创建 apps/api/data/no-wave.sqlite
pnpm dev                           # API :4000 + Web :3000
```

在另一个终端验证整条链路：

```sh
pnpm check:local
```

如果写作台提示“已发布”，但公开页面看不到，且本机没有邮箱/SMTP 服务，可以直接跑：

```sh
pnpm verify:publish
```

它会启动一次性本地栈，补齐公开页面所需的作者资料，通过 Web 写作台代理发布，
匿名读回文章，并打印文章页与作品目录链接。用
`pnpm verify:publish --keep` 可以保留栈和链接，用 `--api-url` / `--web-url`
可以验证已经启动的链。详见[无邮箱服务验证发布可见性](docs/development/local-development.md#61-publishing-visibility-without-mail)。

`pnpm dev` 会打印安全的数据库摘要，例如：

```text
persistence  SQLite (apps/api/data/no-wave.sqlite)
```

重置、排错以及可选的 Docker PostgreSQL 步骤见[本地开发](#local-development)。

<a id="product-and-engineering-direction"></a>
## 产品与工程方向

产品面向华语文学与数字艺术的阅读、发表空间。新产品要保留旧产品的人文科节奏、阅读重量与中文优先的表达，同时让跨设备体验更轻、更容易被感知为一个完整产品。

设计是与工程并列的一等工作流，而不是实现完成后再补的装饰。设计语言需要在大规模实现前写清楚；当前唯一的 Web 实现是 `apps/web-rr` 的 React Router 应用，而视觉设计系统仍处于概念阶段。相关文档见[UI 设计系统（概念阶段）](packages/web-ui/docs/UI_DESIGN_SYSTEM.md)，其中把已完成的技术决定与视觉提案分开记录。

实现刻意保持为**全栈 pnpm monorepo**：一个 Web 应用、一个 API 服务，加上共享契约与 UI 基础组件。这让架构在拆分成多服务之前仍可审读。API 是带有明确应用层边界的模块化单体，因此未来即使拆分服务，也不必先重写 HTTP 契约或 Web 应用。

品牌文案与首篇文章已经是中文优先；面向用户的 UI 文案集中在 `packages/web-ui/src/lib/ui-copy.ts`，因此扩展语言主要是数据工作，而不是重写页面。编辑器路径也已落地：Lexical 提供成熟的编辑行为，项目把自定义工作集中在发表流程、中文排版与呈现上。旧行为从 Next.js 页面迁移到框架无关的共享包，这也是移植工作最终只保留一个框架的原因。

审核工具、分析与实时客户端仍未完成。依赖邮件的邮箱验证和密码找回**已经实现，但默认关闭**，需要运维设置 `MAIL_ENABLED` 才会启用；它们不是“尚未实现”。详见[账户邮件：开启前不会发送](docs/operations/mail-setup.md)。图片上传需要配置 `MEDIA_S3_*` 对象存储；未配置时媒体写入会返回 `503`。

<a id="current-implementation-status"></a>
## 当前实现状态

- 本地 Web/API 链路、REST API 契约测试与设计语言文档均已就位。
- 身份生命周期、资料编辑、文章/评论发表、通知收件箱、审核角色检查、Web 认证 Cookie 边界均已实现。
- 注册会在同一事务里创建默认作者资料，新发布的作品因此有公开署名；写作台可查看并修改笔名。
- 后端身份生命周期仍是初版：邮件验证/找回**默认关闭**，审核工具、实时客户端与外部推送尚未完成；正式上线前仍需一轮安全加固。
- 当前 Web UI 是唯一的 React Router 实现，功能可用；视觉设计仍是概念阶段，不是已完成的设计系统。
- API 认证使用 Bearer token。浏览器通过同源 Web 路由认证并取得 HttpOnly Cookie，浏览器代码不会把长期 token 放在 local storage。
- 旧的 `API_GRAPHQL_URL` 只在一个过渡版本内兼容并会输出弃用警告。新代码必须使用 `/api/v1` REST 路径；见 [REST 幂等性](docs/architecture/rest-idempotency.md)。

结构化工程审查、架构决定与路线图分别见 [docs/audit](docs/audit)、[docs/architecture/decisions](docs/architecture/decisions) 和 [docs/roadmap](docs/roadmap)。

<a id="prerequisites"></a>
## 环境要求

- **Node.js 24.x**，由 `package.json#engines` 与 CI 固定。使用 SQLite 时建议 **24.15.0 或更新版本**，因为更早的小版本中 `node:sqlite` 仍是 Release Candidate API。
- **pnpm 10**，由 `packageManager` 固定。若 `pnpm` 不在 `PATH`，先执行一次 `corepack enable`。
- **Docker Desktop / Docker Engine**：仅可选的本地 PostgreSQL 配置与容器镜像检查需要。默认的 SQLite 路径不需要 Docker。

<a id="persistence-runtime-and-deployment-guidance"></a>
## 持久化运行时与部署建议

`DATABASE_PROVIDER` 选择运行时适配器：

- `sqlite`（默认）使用 Node 内置 SQLite 驱动与本地文件。
- `postgres` 使用 `pg`、`DATABASE_URL` 以及 `apps/api/migrations/postgres` 下的版本化 SQL 迁移。

SQLite 是**本地开发**与单机安装的默认选择。由于 `node:sqlite` 仍是 Release Candidate API，**生产/服务器部署推荐 PostgreSQL**。SQLite WAL 不等于跨主机复制或高可用。运行边界、Node 升级回归要求，以及重新评估驱动选择的条件，见[持久化提供方部署建议](docs/deployment/persistence-provider-guidance.md)与 [ADR 0010](docs/architecture/decisions/0010-sqlite-first-and-online-provider-cutover.md)。

Neon 生产分支的 PostgreSQL URL、私有媒体存储与服务开通见 [Neon 部署与运维](docs/operations/neon-deployment.md)。**不要把该页当作日常本地开发流程**：它会把生产 URL 拉进 `.env.local`，而本地探针会写入数据。账户邮件（密码找回、邮箱验证）已经完成但**默认关闭**，只有运维在 `.env.local` 设置 `MAIL_ENABLED` 后才会发送；详见[账户邮件：开启前不会发送](docs/operations/mail-setup.md)。

## 定时维护

过期会话、已关闭的限流窗口，以及超过保留期的软删除作品，由一个一次性进程
`pnpm --filter @bot-thk/api maintenance` 清理，预期由调度器每小时运行一次。
没有它，低流量实例永远不会清理：进程内那两次顺带的清扫只在有写入时才发生。调度
命令、边界参数与退出码见[定时维护](docs/operations/scheduled-maintenance.md)。

<a id="observability"></a>
## 可观测性

API 在 `/metrics` 输出结构化指标，并提供独立的 API/Web 就绪探针，以及文章、评论指标。`/metrics` 不会返回内部服务配置；见 [API 可观测性](docs/operations/api-observability.md)。健康检查与就绪检查会由本地链路和 CI 覆盖。

<a id="local-development"></a>
## 本地开发

### 推荐：本地 SQLite（不用 Neon，不用 Docker）

除非确实需要 PostgreSQL 的提供方一致性，否则都走这条路径。

1. 安装依赖：

   ```sh
   corepack enable
   pnpm install --frozen-lockfile
   ```

2. 生成局部环境文件：

   ```sh
   pnpm setup:local
   ```

   它会写入被 Git 忽略的仓库根目录 `.env.local`，内容为 `DATABASE_PROVIDER=sqlite`、`DATABASE_PATH=data/no-wave.sqlite`，以及随机生成的 48 字节 `AUTH_JWT_SECRET`。脚本不会覆盖已有文件；需要重新生成时使用 `pnpm setup:local --force`。

3. 显式执行迁移。`pnpm dev` 不会在启动时自动改 schema：

   ```sh
   pnpm db:migrate
   ```

4. 启动两个进程：

   ```sh
   pnpm dev
   ```

   `pnpm dev` 会启动两个进程，分别可通过 `http://127.0.0.1:4000`（API）与 `http://127.0.0.1:3000`（Web）访问；它会等待两者就绪，并可用一次 `Ctrl+C` 同时停止。它也会打印当前选中的数据库。`pnpm dev --check` 会在两者就绪后立即跑连通性探针；`pnpm check:local` 则适合在第二个终端执行。

5. 验证链路：

   ```sh
   pnpm check:local
   ```

   探针按数据库 → API → Web 的依赖顺序检查。若不想写入，使用 `pnpm check:local --read-only`。

> **为什么本地优先？** `pnpm check:local` 会刻意创建一次性账号、资料和已发布文章。反复对 Neon/共享分支跑这一流程会浪费额度，也会把开发数据写进共享数据库。本地 SQLite 可随时丢弃、启动快，而且不需要任何凭据。

### 我的数据在哪里？

默认 SQLite 文件是 `apps/api/data/no-wave.sqlite`，WAL/SHM 文件与它放在同一目录。`DATABASE_PATH` 相对于 `apps/api` 解析，而不是仓库根目录。`pnpm dev` 打印的是**仓库相对路径**，既能定位文件，又不会在复制终端输出时泄露用户主目录：

```text
persistence  SQLite (apps/api/data/no-wave.sqlite)
```

本地 PostgreSQL URL 会打印已隐藏密码的 URL；若是**外部** URL，则打印 `PostgreSQL (external DATABASE_URL; host withheld)` 并提醒切回本地数据库。终端不会输出密码、完整 `DATABASE_URL`、Neon 主机名、token 或生产路径。

shell 中导出的变量优先于 `.env.local`，而 `.env.local` 被 Git 忽略。若要重置本地 SQLite，先停止 `pnpm dev`，删除 `apps/api/data/no-wave.sqlite*`，再执行 `pnpm db:migrate`。完整变量说明见 `.env.example` 与[本地开发与本地验证](docs/development/local-development.md)。

### 本地开发时避免 Neon

- 不要把 Neon 的 pooled / unpooled `DATABASE_URL`、`DATABASE_URL_UNPOOLED` 粘贴进 `.env.local`。
- 不要在 `pnpm dev` 之前运行 `neon env pull`；它可能用生产 URL 覆盖 `.env.local`。如果已经执行过，运行 `pnpm setup:local --force`。
- `pnpm setup:local --postgres` 会忽略从 shell 继承的外部 `DATABASE_URL`，改为写入一次性的本地 compose URL。
- 当 `DATABASE_URL` 或 `DATABASE_URL_UNPOOLED` 指向外部主机时，`pnpm dev` 会给出警告。看到警告后，清除两个变量并重新生成 `.env.local`：

  ```sh
  # macOS / Linux
  unset DATABASE_URL DATABASE_URL_UNPOOLED
  pnpm setup:local --force

  # PowerShell
  Remove-Item Env:DATABASE_URL, Env:DATABASE_URL_UNPOOLED
  pnpm setup:local --force
  ```

  重新打开一个终端也会清除仅在当前 shell 中导出的变量。

仅用于部署的 Neon 步骤请放在独立环境中，参考 [Neon 部署与运维](docs/operations/neon-deployment.md)，不要混进本地开发循环。

### 可选：Docker 中的本地 PostgreSQL

只有在需要 PostgreSQL 行为（连接配置、持久化 outbox，或集成测试数据库）时才使用。它仍然是本地数据库，凭据也仍是一次性值。

```sh
pnpm db:up                         # postgres:17-alpine + bot_thk_dev + bot_thk_test
pnpm setup:local --force --postgres
pnpm db:migrate
pnpm dev
```

`pnpm db:down` 停止容器但保留 volume；`pnpm db:reset` 停止容器并删除 volume。只有希望 `pnpm test` 同时跑 PostgreSQL 集成套件时，才取消注释 `.env.local` 中的 `TEST_DATABASE_URL`。绝不要把 `.env.local` 指向共享、预发布或生产数据库：探针会写入数据。

### 验证与排错

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| `SQLite schema is not current` | 尚未执行迁移。 | `pnpm db:migrate`。 |
| `AUTH_JWT_SECRET is N bytes` | secret 缺失或太短。 | `pnpm setup:local --force`。 |
| 认证路由返回 `503` | API 使用了无效 secret 启动。 | 用有效的 `.env.local` 重启。 |
| `4000` 或 `3000` 端口被占用 | 另一个开发进程还在运行。 | 停止它，或设置 `PORT` / `WEB_PORT`。 |
| API 步骤通过但页面为空 | Web 仍在使用 fixture，或无法连到 API。 | 检查 `API_BASE_URL=http://127.0.0.1:4000`，再跑 `pnpm check:local`。 |
| `pnpm dev` 警告外部数据库 | shell 或 `.env.local` 中存在 Neon/共享 URL。 | 清除 `DATABASE_URL` / `DATABASE_URL_UNPOOLED` 并执行 `pnpm setup:local --force`。 |
| 请求 `localhost` 出现 `fetch failed` | `localhost` 解析到 `::1`，而 API 只监听 IPv4。 | 在 `API_BASE_URL` 中使用 `127.0.0.1`。 |

### 一条可移植命令

`pnpm stack:start` 会以普通 `node` 子进程启动 API、Web、迁移与 outbox drain，不依赖 Vercel service binding。`pnpm stack:check` 做同样的事，但会额外用一条命令验证整个栈。两者都只从文档中列明的变量组装环境，不继承整个 shell。默认配置会使用一次性的本地 SQLite 文件；运行前不要导出 Neon `DATABASE_URL`，因为 `stack:check` 会采用它。见 `scripts/portable-stack.ts`。

### 部署

本仓库只有一条部署路径，不再附带平台清单：两个容器镜像（`apps/api/Dockerfile`、`apps/web-rr/Dockerfile`）加上上面三个进程。CI 的 `container-image` 任务会构建这两个镜像、在同一网络启动、只靠 `API_BASE_URL` 打通两层，并从外部用 HTTP 探测；`portable-stack` 任务则不用 Docker 跑同一批进程。因此「部署的东西」就是「被测过的东西」——契约见 [可移植栈](docs/operations/portable-stack.md)，镜像细节见[容器镜像](docs/operations/portable-stack.md#container-images)。

`vercel.json` 已于 2026-11-07 删除（[ADR 0029](docs/architecture/decisions/0029-one-deployment-path.md)）：它把同样的三个工作负载声明为 Vercel Services，但本仓库从未真正部署过；一份没人运行的清单只是声明，不是配置。把容器托管到任何平台仍然可行，但要重新引入平台清单，需要一个真正跑过的部署来验证。

<a id="other-checks-and-commands"></a>
## 其他检查与命令

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | 对所有 workspace 做类型检查。 |
| `pnpm test` | 运行根级单元测试与 API 契约测试列表。 |
| `pnpm test:routes` | Web 路由级 smoke 检查。 |
| `pnpm build` | 构建 React Router Web 应用。 |
| `pnpm dev --api-only` / `--web-only` | 只启动一个进程，例如 API 已跑在容器中时。 |
| `pnpm dev --check --exit` | 探针完成后停止两个进程；CI 使用。 |
| `pnpm check:local --read-only` | 不写入数据，只验证链路。 |
| `pnpm verify:publish` | 无邮箱服务验证写作台发布可见性，并打印文章链接。 |

<a id="postgresql-integration-tests"></a>
## PostgreSQL 集成测试

根级 `pnpm test` 可以在没有数据库的情况下运行：`apps/api/src/persistence/sqlite.test.ts` 会在本地执行，缺少 `TEST_DATABASE_URL` 时 PostgreSQL 套件会自行跳过。把 `TEST_DATABASE_URL` 指向**可丢弃**的数据库即可启用：

```sh
pnpm db:up
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/bot_thk_test \
  pnpm --filter @bot-thk/api test:integration
```

Windows PowerShell 需要先设置 `$env:TEST_DATABASE_URL`，再执行同一命令。运行迁移或集成测试时，`DATABASE_URL` 与 `DATABASE_URL_UNPOOLED` 都不得指向生产。

<a id="database-and-url-configuration-reference"></a>
## 数据库与 URL 配置参考

- `DATABASE_PROVIDER` 选择 `sqlite` 或 `postgres`；两者共用同一套 REST 契约。
- `DATABASE_PATH` 相对于 `apps/api` 解析，默认是 `data/no-wave.sqlite`；`:memory:` 仅适用于临时测试。
- `DATABASE_URL` 是 PostgreSQL 查询 URL。本地 PostgreSQL 请使用 `.env.example` 中的 compose 值。`DATABASE_URL_UNPOOLED` 是仅用于部署迁移的覆盖项。
- `DATABASE_AUTO_MIGRATE=true` 是一次性本地环境的便捷开关；文档流程仍显式执行 `pnpm db:migrate`。
- `API_BASE_URL` 告诉 Web 服务 API 在哪里。`pnpm dev` 会自动接线；本地链路不要把它指向远程 API。
- `POSTGRES_PORT` 可修改 `compose.yaml` 发布到主机的端口。
- 优先级为：shell 导出 > `.env.local` > 代码默认值。绝不要把共享、预发布或生产凭据写进 `.env.local`。

<a id="ci"></a>
## CI

CI 分阶段执行依赖安装、类型检查、Web/API 测试、路由 smoke、容器镜像 smoke、Playwright e2e、PostgreSQL 集成，以及本地链路任务（`pnpm dev --check --exit`）。GitHub Actions 工作流是权威来源，GitLab 流水线镜像其验证阶段。见 `.github/workflows/ci.yml` 与 `.gitlab-ci.yml`。

<a id="lexical-note"></a>
## 术语说明

部分历史文档仍把 Web UI 称为“portability/content spike”。该 spike 已退役：`apps/web-rr` 是唯一的 Web 实现。设计系统文档是概念提案，不是第二个框架，也不是另一套已部署的 UI。
