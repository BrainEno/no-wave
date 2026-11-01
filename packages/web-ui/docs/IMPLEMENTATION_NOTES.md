# 无浪潮 No Wave · 前端落地说明

对应设计规范：`docs/UI_DESIGN_SYSTEM.md`（v0.2）。本文说明**哪些已按真实 API 落地，哪些因后端缺口没有落地**。

## 1. 页面与数据来源（均来自现有 GraphQL 客户端 `src/lib/api-content.ts`）

| 路由（`/en/…` 为英文） | 页面 | 数据 | 说明 |
|---|---|---|---|
| `/` | 首页 | `articles`、`taxonomies` | 精选 = 最新 3 篇；最新 = 之后 6 篇；主题取自分类，没有分类时退回作品类型 |
| `/articles` | 作品目录 | `articles(query, limit, offset)` | 类型标签、搜索、分页 |
| `/articles/[slug]` | 作品阅读页 | `article`、`articles` | 诗歌 / 散文式版式随 `workType`；目录取自正文标题块；上一篇/下一篇与相关作品取自最新 100 篇 |
| `/authors/[username]` | 作者主页 | `authorProfile`、`articles` | 近期作品 = 最新 3 篇；目录支持类型筛选与分页 |
| `/categories`、`/categories/[slug]` | 分类 | `taxonomies`、`taxonomy`、`taxonomyArticles` | |
| `/search` | 搜索（新增） | `articles(query)`、`taxonomies(query)` | “作者”结果由匹配作品汇总，没有独立作者检索接口 |
| `/sign-in` | 登录（占位） | — | 保持“尚未实现”，仅换成新样式 |
| `loading.tsx` / `error.tsx` / `not-found.tsx` | 加载 / 错误 / 404 | — | 骨架屏、重试按钮、双语 404 |

派生数据（没有后端字段，直接由正文计算）：篇幅（字数 / 词数）、阅读时长、诗歌摘句。

## 2. 设计稿里有、但后端目前没有的功能（**没有伪造，没有做假交互**）

| 设计稿功能 | 现状 | 需要的后端能力 |
|---|---|---|
| 作品讨论页、精读 / 短评 / 作者回应 | 未实现，没有路由 | 评论与讨论接口（含段落锚点、层级、排序） |
| 作者投稿 / 发布作品页与编辑器 | 未实现，没有路由 | 草稿、保存、提交审核接口与身份验证 |
| 关注作者 / 点赞 / 收藏 | 未显示 | 关注与互动接口 |
| 通知铃铛的未读数 | 铃铛已显示，**无角标**；面板提示“暂无通知，登录后查看” | 通知接口（`SiteChrome` 里的 `unread` 常量是接入点） |
| 编辑精选 / 编辑推荐 | 用“最新发表”代替 | 推荐标记字段 |
| 封面图 | 全部使用默认抽象占位图（`hash(slug) % 4`） | 文章封面字段；有封面后在 `pickDefaultCover` 之前优先使用 |
| 作者头像、关注者数 | 用占位图 / 不显示 | 作者资料字段 |
| 作品类型 / 排序 / 作者过滤参数 | 类型筛选在最新 100 篇匹配作品里做内存筛选；无排序控件 | `articles` 增加 `workType`、`authorId`、`sort` 参数与总数 |

## 3. 与旧版行为不同的地方（需要你确认）

1. **分类路由原先硬编码 `zh-TW`**，而首页用 `zh-CN` 取分类。现统一改为默认语言（`zh-CN`）。若后端分类数据其实是 `zh-TW`，请改回。
2. 作品目录和作者目录的类型筛选只作用于**最新 100 篇**，页面上有一行说明。
3. 全站外壳（竖脊、导航条、页脚、平滑滚动）移到了根布局 `src/app/layout.tsx`，各页面不再自带导航。
4. 删除了旧的 `home-page.module.css`，样式统一在 `src/app/globals.css`（`nw-` 前缀）。

## 4. 动效实现

- 依赖：`gsap@3.13.0`（含 ScrollTrigger、ScrollSmoother）。**已写进 `package.json`，需要执行 `pnpm install` 更新锁文件。**
- `SiteChrome`（客户端）创建全站唯一的 ScrollSmoother，并在每次路径或查询串变化后重新绑定页面动效；竖脊、导航条、颗粒层在平滑滚动容器之外。
- 页面保持服务端组件，用 data 属性声明动效（见 `src/components/motion/page-motion.ts` 头部注释）：`data-intro`、`data-scatter`、`data-hero`、`data-reveal`（mask / row / wipe / 默认）、`data-parallax`、`data-marquee`、`data-footer-letters`。
- WebGL 只在首页首屏（`HeroCanvas`）：涂抹浮现、鼠标推开颜料、滚动速度拖拽；离开视口暂停渲染；不支持 WebGL 时保留静态图。
- 载入页（`PageLoader`）每个会话只播放一次（`sessionStorage`）。
- `prefers-reduced-motion`：不创建平滑滚动、不跑马灯、不播放载入页、颗粒层隐藏，WebGL 直接显示清晰画面。

## 5. 资源

- `public/covers/*.jpg`：4 张默认封面；`scripts/generate_cover.py`：按文章 slug 生成更多变体（依赖 numpy、Pillow）。
- 首屏纹理 `cover-ember-16x10.jpg` 约 700KB，已接近 UI 规范里 800KB 的上限，上线前建议再压缩并提供 WebP/AVIF。
- 字体通过 Google Fonts `<link>` 加载（`layout.tsx`）。若要在国内稳定访问，建议自托管子集。

## 6. 验证状态

- `tsc --noEmit` 通过（**对 gsap 使用了临时类型桩**，因为沙箱不能安装 gsap；真实类型下请再跑一次 `pnpm typecheck`）。
- `pnpm test`（Node 内置测试）27 项全部通过，含新增的封面选择、作品类型解析、分页、高亮、阅读统计。
- **没有运行 `next build`，也没有在浏览器里看过效果**：沙箱里的 `node_modules` 缺少 Next 的原生依赖，无法启动。请本地执行 `pnpm install && pnpm dev` 后逐页检查。
