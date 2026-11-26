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

## 各页面的范围（#417 验收）

| 面 | 行为 |
|---|---|
| 首页、文章、档案、标签 | 路径只识别 `/en` 前缀作为英文，其余路径都是 `zh-CN`（`apps/web-rr/app/lib/locale.ts`）。没有 `/zh-TW` 前缀。 |
| 认证与恢复页（登录、注册、找回密码、验证邮件） | 文案只有 `zh-CN` 与 `en`。页面语言跟随上面的路径规则。 |
| 错误页（404、500、503） | 文案来自 `zh-CN` 与 `en`，没有繁体版本。 |
| SEO、hreflang、sitemap、canonical | 站点语言来自 `supportedLocales = ["zh-CN", "en"]`（`packages/web-ui/src/lib/content.ts`）。hreflang 与 sitemap 只列出这两种语言，不输出 `zh-TW` 条目。 |
| 字体 | 字形子集由 `zh-CN` 与英文文案生成（`scripts/fonts/repertoires.ts`）。繁体文案已移除，所以繁体字形不在子集中，没有繁体专用字体。 |
| 用户可见的语言入口 | 只显示 `zh-CN` 与 `en`。 |

## 验收状态

- 决定记录覆盖的面：首页、文章、档案、认证与恢复、写作台、错误页、SEO 与 hreflang、API locale、字体。
- 本决定选择了“暂不加入 `zh-TW`”，因此 #417 验收中“若加入”的条目（繁体 E2E、metadata 验证）不适用。
- 用户可见的语言入口与文档中的范围说明一致。

## 已有的 zh-TW 数据

- 已有的 `zh-TW` 作品仍可读取、编辑和保存，语言保持为 `zh-TW`。`PUT` 请求仍接受三个存储语言值，所以旧作品可以被保存。
- 数据库约束与历史迁移没有改动。迁移 `0008` 已经把繁体行复制为简体行。
- 本次没有对已有数据做改名、转换或删除。

## 尚未覆盖，需要 owner 决定

- Notion 导入已拦截 `zh-TW` 版本（PR #424）。目录版本（catalogue edition）路由本身只读，不会创建版本；但 `PUT /api/v1/articles/{id}` 仍可为缺少繁体版本的作品新增 `zh-TW` 版本，这一缺口仍然开放。
- 已有的繁体作品之后应该转为简体、只读，还是保持可编辑。这需要决定。
- 本机文稿中已有的繁体草稿仍可被读取和比较，但不能再新建。

## 验证方式

- API 的 `POST /api/v1/articles` 拒绝 `zh-TW`，并保留 `PUT` 对既有作品的编辑路径。相关测试位于 `apps/api/src/transport/rest/authoring-locales.integration.test.ts`。
- web-ui 测试覆盖内容回退、标签文案、版本预览和导入校验。
- e2e 中的旧作品场景改为通过 `PUT` 添加繁体版本。
