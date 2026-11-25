# 名称与关系：BOT THK、no-wave、无浪潮

Status: active

这个仓库里同时出现三个名字。它们指的是不同的东西，改名的成本也不同。本文说明每个名字现在指什么、在哪里出现，以及新建资源应该用哪一个。

## 三个名字

| 名称 | 指什么 | 现在出现在哪里 |
|---|---|---|
| **BOT THK** | 旧项目与本产品的历史名称。本仓库是它的独立实现，旧项目只作为功能与行为参考。 | README 标题与首段；`docs/requirements/behavior-baseline.md` 等历史与参考文档 |
| **no-wave** | 仓库名（GitHub `BrainEno/no-wave`），也是本地容器与临时文件的前缀。 | `compose.yaml` 的容器名 `no-wave-postgres`；CI 与脚本里的临时文件，如 `/tmp/no-wave-e2e.sqlite` |
| **无浪潮 / No Wave** | 面向读者的对外品牌。中文用“无浪潮”，英文用 “No Wave”。 | 站点竖脊、导航、页面标题与 `packages/web-ui/src/lib/ui-copy.ts` 中的品牌文案 |

## 已经存在的名称：保持不变

下面这些名称已经被代码、数据库或部署环境引用。改它们需要迁移，不是改个字符串就能完成，所以现在保持原样：

- 根包名 `bot-thk`，以及工作区包 scope `@bot-thk/*`（`apps/api`、`apps/web-rr`、`packages/*`）。
- 开发数据库名 `bot_thk_dev`（`compose.yaml` 的 `POSTGRES_DB`，CI 中也使用），测试库名 `bot_thk_test`。
- CI 构建的 API 镜像标签 `bot-thk-api:ci`。

## 新建资源：使用 no-wave

在仓库内新建的资源，例如新的数据库、容器、镜像、脚本前缀和临时目录，统一使用 `no-wave`。面向读者的文案使用 `无浪潮` 或 `No Wave`，不要使用 `BOT THK`。

## 未决定的事项

- BOT THK 是否仍是对外品牌或公司名，目前没有定论。
- 是否计划把包名从 `@bot-thk/*` 迁移为 `@no-wave/*`，目前没有计划。如果决定迁移，需要单独的迁移方案，并同步更新 CI、镜像标签与数据库默认名。

这两项需要仓库负责人确认，见 issue #355。
