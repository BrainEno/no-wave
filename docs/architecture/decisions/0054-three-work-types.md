# ADR 0054: 作品类型只保留三种：小说、诗歌、其他文体

- Status: Accepted
- Implementation: Done
- Date: 2026-11-23
- 关联：[ADR 0016](0016-editorial-taxonomy-and-editor-role.md)（编辑分类不受影响，只是退出分类页与导航）；[ADR 0036](0036-notion-as-interchange-format.md)（Notion 标签到作品类型的映射随之收拢）

## 背景

作品类型原有九种：`novel`（长篇）、`short_story`（短篇）、`serial`（连载，已停用但仍可存在）、
`poetry`、`essay`、`criticism`、`literary_criticism`、`nonfiction`、`other`。作品库的标签栏
列出八种，首页列六种，写作台的下拉框给九种。分得太细：作者自己在 Notion 里只用「小说、诗歌
（诗）、其他」三个标签，站上大多数类型几乎没有作品，读者面对的却是一排空筛选。

## 决定

1. **只有三种类型：小说 `novel`、诗歌 `poetry`、其他文体 `other`。** 合并规则：
   `short_story`、`serial` → `novel`；`essay`、`criticism`、`literary_criticism`、
   `nonfiction` → `other`；`novel`、`poetry`、`other` 不变。
2. **数据一次迁移，不可逆。** PostgreSQL `0039_three_work_types`、SQLite
   `0026_three_work_types` 改写所有作品；之后写合同和数据库本身都只接受三个值（PostgreSQL
   换掉 `articles_work_type_check`；SQLite 加两个 `BEFORE INSERT/UPDATE` 触发器）。迁移和
   0017/0026 一样，在有进行中的跨库迁移会话时拒绝执行。迁移不保留旧值。
3. **沿用 `novel` 这个存储值表示全部小说，不新造 `fiction`。** SQLite 的列 CHECK（0001）
   不能就地修改，而重建 `articles` 表在本仓库的迁移方式下不安全：迁移在一个事务里执行、
   外键始终开启，删除旧表会级联删掉所有子行。沿用 `novel` 只需要改数据和加触发器；现有的
   `?type=novel` 链接、Notion「小说 → novel」映射也都不用变。代价是英文值名不如 `fiction`
   贴切，界面文案统一显示为「小说 / Fiction」。
4. **旧值在前端读作它所属的组，不报错。** `parseWorkType` 把六个旧值映射到组，覆盖迁移
   改不到的地方：收藏的 `?type=short_story` 链接、浏览器里的本机草稿与恢复点、备份文件、
   文稿集合文件、阅读清单、导入表格。文稿集合的条目摘要按文件里写的原值校验，通过后再按新值
   重算，旧集合文件因此仍能打开，篡改也仍然会被发现。
5. **`/categories` 只列三种类型及其作品数。** 编辑维护的分类（ADR 0016）退出这个页面和首页，
   但 `/categories/:slug` 仍然可以访问。首页的「分类」区块改为三栏，每栏列该类最新三篇。
6. **作品数来自有界窗口。** 公开 API 没有作品类型参数，计数与作品库的类型筛选一样，取最新
   100 篇在内存里统计；窗口取满时显示「N+ 篇」，不声称精确数字。

## 后果

- 「连载已停用但仍可保存」这条兼容规则（#196）随之删除：已经没有任何作品是 `serial`。
- 依赖作品类型摘要的 Notion 重新导入：之前按「短篇」「散文」等标签导入过的页面，摘要里的
  类型会从旧值变成组名，下一次预演会把这些页面报告为「有变化」，确认后只是把同样的内容再写
  一次。作者的 Notion 标签只有小说 / 诗歌 / 诗 / 其他，「小说 → novel」不变，这些页面不受影响。
- 作品库按类型筛选与分类页的计数仍受「最新 100 篇」窗口限制；要精确计数，需要给公开 API
  增加作品类型参数或计数接口。

## 验证

- `work-type-schema-upgrade.test.ts`：九种旧值各一篇作品，迁移后归入正确的组，其他列不变；
  数据库拒绝旧值；有进行中的跨库迁移会话时迁移拒绝执行且不改任何数据。
- `persistence-adapter-contract.test.ts`：两种数据库都只能写入三种类型，绕过合同直接写库也会被拒绝。
- `work-types.test.ts`、`writing-backup.test.ts`、`writing-collection.test.ts`：旧值的链接、
  备份文件和集合文件仍能读取，并读作所属的组。
