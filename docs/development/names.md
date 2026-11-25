# 名称与关系：no-wave 与无浪潮

Status: active

这个仓库里有两个在用的名字。它们指的是不同的东西：`no-wave` 是工程名，`无浪潮 / No Wave` 是面向读者的品牌。本文说明每个名字指什么、出现在哪里，以及新建资源应该用哪一个。

## 两个在用的名字

| 名称 | 指什么 | 现在出现在哪里 |
|---|---|---|
| **no-wave** | 项目、仓库与包的正式名称。 | GitHub 仓库 `BrainEno/no-wave`；根包名 `no-wave`；工作区包 scope `@no-wave/*`；`compose.yaml` 的容器名 `no-wave-postgres` 与开发库 `no_wave_dev`；CI 镜像 `no-wave-api:ci`；临时文件前缀如 `/tmp/no-wave-e2e.sqlite` |
| **无浪潮 / No Wave** | 面向读者的对外品牌。中文用“无浪潮”，英文用 “No Wave”。 | 站点标题、导航、页面标题，以及 `packages/web-ui/src/lib/ui-copy.ts` 中的品牌文案 |

## 已停用的旧名称

项目早期使用过另一个旧名称。它已经从代码、配置、当前文档、测试数据和对外文案中移除，新内容不要再使用它。

它只保留在历史文档中：`docs/architecture/decisions/`（ADR）、`docs/audit/` 与 `docs/archive/`。这些文件记录的是当时的决定与审计结果，不做改写。指向外部旧仓库的链接也保持原样，因为它们指向另一个仓库。

## 有意保持不变的字符串

- 用于 HMAC 的域分隔字符串（如 `article-view:v1`、`write-rate-limit:v1` 前的命名空间）。它们参与哈希计算，改动会改变已存的摘要与限流键。
- 文章、用户等业务数据中已存在的内容。本次只改名称，不迁移数据。

## 迁移影响

- 开发数据库名由 `bot_thk_dev` / `bot_thk_test` 改为 `no_wave_dev` / `no_wave_test`。已有本地 Postgres 数据卷中的旧库名不会自动改变，需要重建数据卷，或手动重命名数据库，再重新执行 `pnpm setup:local` 生成 `.env.local`。
- 包 scope 改为 `@no-wave/*` 后，依赖旧 scope 的外部脚本或分支需要同步更新。

## 新建资源：使用 no-wave

在仓库内新建的资源，例如新的数据库、容器、镜像、脚本前缀和临时目录，统一使用 `no-wave`。面向读者的文案使用 `无浪潮` 或 `No Wave`。

## 决定记录

- 2026-11-25（issue #355）：仓库负责人决定，旧名称全部改为 `no-wave`，包 scope 从旧 scope 迁移到 `@no-wave/*`。
- 无浪潮 / No Wave 继续作为读者品牌；本次没有改动它。如果品牌方向有变，需要另行决定。
