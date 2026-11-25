# 语言范围：只支持简体中文与 English

Status: active

本文记录 issue #417 的决定。仓库负责人决定：繁体中文（`zh-TW`）暂不支持。所有新内容只使用简体中文（`zh-CN`，主语言）或 English（`en`）。

## 决定范围

| 范围 | 行为 |
|---|---|
| 公共 Web 路由 | `zh-CN`（默认，无前缀）与 `en`（`/en/...`）。没有 `zh-TW` 路由。 |
| 界面文案与示例内容 | `packages/web-ui/src/lib/content.ts` 只保留 `zh-CN` 与 `en`。`zh-TW` 文案和示例内容已移除，请求 `zh-TW` 时回退到默认语言 `zh-CN`。 |
| 写作台 | 新作品只能选择 `zh-CN` 或 `en`。批量导入的语言选项与列表中的繁体选项已移除。 |
| 批量导入 | 导入文件被识别为繁体时会给出校验错误，要求改为简体中文或 English，不会静默保存为简体。 |
| REST API | `POST /api/v1/articles` 对 `zh-TW` 返回 `400 BAD_USER_INPUT`。 |
| 版本预览 | `zh-TW` 只在作品已有繁体版本时显示。 |

## 已有的 zh-TW 数据

- 已有的 `zh-TW` 作品仍可读取、编辑和保存，语言保持为 `zh-TW`。`PUT` 请求仍接受三个存储语言值，所以旧作品可以被保存。
- 数据库约束与历史迁移没有改动。迁移 `0008` 已经把繁体行复制为简体行。
- 本次没有对已有数据做改名、转换或删除。

## 尚未覆盖，需要 owner 决定

- 通过 Notion 导入，以及目录版本（catalogue edition）路由创建 `zh-TW` 版本，目前还没有被拦截。
- 已有的繁体作品之后应该转为简体、只读，还是保持可编辑。这需要决定。
- 本机文稿中已有的繁体草稿仍可被读取和比较，但不能再新建。

## 验证方式

- API 的 `POST /api/v1/articles` 拒绝 `zh-TW`，并保留 `PUT` 对既有作品的编辑路径。相关测试位于 `apps/api/src/transport/rest/authoring-locales.integration.test.ts`。
- web-ui 测试覆盖内容回退、标签文案、版本预览和导入校验。
- e2e 中的旧作品场景改为通过 `PUT` 添加繁体版本。
