# 默认封面（抽象占位图）

文章没有封面时使用。规则：`hash(slug) % 4` 选一张，同一篇作品永远是同一张（见 `src/lib/covers.ts`）。
装饰图，`alt=""`。需要更多变体：`python scripts/generate_cover.py --post-id <slug> --size 1200x1500 -o out.jpg`。

| 文件 | 尺寸 | 用途 |
|---|---|---|
| cover-ember-16x10.jpg | 2400×1500 | 首页首屏 WebGL 纹理、宽幅 |
| cover-oxblood-4x5.jpg | 1200×1500 | 作品封面（竖） |
| cover-bone-1x1.jpg | 1200×1200 | 方图 |
| cover-night-3x4.jpg | 900×1200 | 小竖图 |
