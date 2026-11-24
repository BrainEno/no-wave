# ADR 0057: 设计令牌阶梯与内联样式政策

- Status: Accepted
- Implementation: Done — `globals.css` 落地 spacing / radius / z-index 三组阶梯与工具类，`packages/web-ui` 内联 `style={{` 从 140 处降到 1 处（带注释），并由 `pnpm lint:inline-styles` 守门。
- Date: 2026-11-24
- 关联：issue #345（设计令牌不完整）

## 背景

`packages/web-ui/src/styles/globals.css` 只有 14 个颜色/字体变量，没有间距、圆角、
层级的阶梯；组件里散落 140 处 `style={{…}}` 内联样式写死间距与尺寸，`z-index` 散在
十余个值上。没有阶梯时，新代码只能凭感觉写数字：不同页面的留白不一致，想整体调整
节奏（例如移动端收紧间距）必须逐个组件改；新增浮层只能「比现有最大再加 5」。

## 决定

### 1. 三组阶梯落地为 CSS 变量，写进 `:root`

- **间距** `--space-1`…`--space-30`：4px 基准，步进取自版面实际节奏（含实现实际
  使用的 20px 与 48px 两档），与 `UI_DESIGN_SYSTEM.md` §3.3 的记录一一对应。
- **圆角** `--radius-xs` 2 / `--radius-sm` 4 / `--radius-md` 6 / `--radius-lg` 8 /
  `--radius-panel` 18 / `--radius-pill` 999（px）：默认仍是 0，面板与胶囊是仅有的
  圆角色。
- **层级** `--z-grain` -1 … `--z-skip` 120：14 个语义档位（纸纹、首屏、吸顶工具条、
  吸底发布条、浮层、竖脊、进度线、导航条、通知面板、菜单、浮动工具条、载入幕布、
  跳转链接），记在 `UI_DESIGN_SYSTEM.md` §3.6。

`globals.css` 内凡落在阶梯上的 `margin` / `padding` / `gap` 字面值、全部 `z-index`
与圆角字面值，一律改为引用变量（计算值不变）。字号、宽度、高度属于排版与布局度量，
不在本次范围内，仍保留字面值。

### 2. 组件内联样式：静态值进工具类，运行时值才允许内联

`style={{…}}` 里的静态间距/布局改为 `globals.css` 的工具类（`.nw-mt-*`、`.nw-mb-*`、
`.nw-container`、`.nw-spacer`、组件专用类等）。只有运行时才能确定的值——对选区的
测量、按数据计算的布局——才允许保留内联，且**每处必须在同行或上一行注释说明为何
必须内联**。`packages/web-ui` 内 `style={{` 上限 **15 处**（本次降到 1 处）。

### 3. 守门

新增 `scripts/check-inline-styles.ts`（`pnpm lint:inline-styles`，接入 `pnpm lint`）：
统计 `packages/web-ui` 内 `style={{` 的出现次数，超上限或缺注释即失败。注释里的
`style={{` 不计（块注释先被抹掉）。

## 影响

- 新增/调整间距、圆角、层级时有唯一取值来源；`UI_DESIGN_SYSTEM.md` §3.3、§3.6 是
  配套记录，改阶梯要同步改文档。
- 守门脚本让上限与注释约定不会随时间回退；例外（运行时内联）必须写理由，审查时
  一眼可辨。
