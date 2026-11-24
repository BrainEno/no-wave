# ADR 0056: 格式检查分目录逐步纳入；ESLint 加入类型感知的 Promise 规则

- Status: Accepted
- Implementation: In progress（格式检查已纳入 `scripts/`、`e2e/`；类型感知规则已全仓生效）
- Date: 2026-11-21
- 关联：issue #317（质量门禁名不副实）、#274

## 背景

`pnpm format:check` 只检查三个文件（`eslint.config.ts`、`.stylelintrc.json`、
`scripts/lint-policy.test.ts`）：随便改坏 `apps/` 里任何一个文件的格式，它照样通过。
ESLint 用 Babel 解析器，只有三条规则（hooks 顺序与依赖、图片 alt），看不到类型，
所以发现不了没人 `await` 也没人 `void` 的 Promise：在服务端，这样的 Promise
一旦 reject 就是未处理的拒绝，Node 会让整个进程退出；在测试里，一个没 await 的
`assert.rejects(...)` 会让测试空过。

## 决定

### 1. 格式：Prettier 分目录逐步纳入，不一次性改全仓

实测（`main@6dab44f`）：Prettier 会改动 1,108 个 TypeScript 文件中的 972 个；
`printWidth` 80 / 120 / 160 时分别是约 17.2 万 / 9.1 万 / 6.2 万行新增。宽度不是
主要原因：代码里大量的单行写法（`try { … } finally { db.close(); }`、一行多条语句）
本身就和 Prettier 的输出不同。一次性格式化会让 `git blame` 失效，并和所有并行分支冲突。

所以按目录分批纳入，每批是**只含格式化**的单独提交，并写进 `.git-blame-ignore-revs`：

| 批次 | 范围 | 状态 |
| --- | --- | --- |
| 1 | `scripts/**/*.{ts,cjs}`、`e2e/**/*.ts`（以及原有的 `eslint.config.ts`、`.stylelintrc.json`） | 已完成 |
| 2 | `packages/glob-match`、`packages/web-http` | 待做 |
| 3 | `apps/web-rr` | 待做 |
| 4 | `apps/api` | 待做 |
| 5 | `packages/web-ui` | 待做 |

`pnpm format:check` 的参数就是当前已纳入的范围；还没纳入的目录以上表为准。
沿用 Prettier 默认配置（与已纳入的文件一致），不为迁就旧写法而调参数：参数调到
160 也照样会改动几乎每个文件。

**生成的文件不纳入。** 例如 `scripts/lib/persistence-slices.manifest.json` 由生成器用
`JSON.stringify(…, 2)` 写出，并由生成器自己核对是否过期；Prettier 会把短数组折成一行，
两边会互相改写。这类文件以生成器的输出为准。

### 2. 类型感知的 ESLint 规则

ESLint 改用 typescript-eslint 的解析器（带类型信息），开启：

- `@typescript-eslint/no-floating-promises`：Promise 必须 `await`、`return`、
  `.catch`，或显式 `void`（`void` 是可以审阅的「有意不等」）。`node:test` 的
  `test`/`it`/`describe`/`suite` 例外：注册测试返回的 Promise 归测试运行器管。
- `@typescript-eslint/no-misused-promises`：在要求布尔值或无返回值回调的地方传入
  Promise，例如 `onClick={async…}`、`createServer(async…)`、`setTimeout(asyncFn)`。

规则引入时全仓只有 16 处违规，逐一审过。其中 API 服务器的请求监听器是真问题：
`try` 之前（请求观测、准入）或写 500 时抛出的错误会变成未处理的拒绝，进而让 API
进程退出。现在由监听器兜底：记录日志，只断开这一个连接（附回归测试）。其余
都是本身已经捕获了错误的处理函数，改为显式 `void`。

**TypeScript 版本。** 仓库用 TypeScript 7.0（原生实现），它的 npm 包不提供
typescript-eslint 读取类型所需的 JavaScript 编译器 API；typescript-eslint 8 支持
TypeScript < 6.1，原生路径（`@typescript/native`）要求 7.1 以上。因此新增仅供 lint
使用的工作区包 `packages/eslint-typescript`，让 typescript-eslint 的 `typescript`
对等依赖解析到 6.0.3；构建、`pnpm typecheck` 和编辑器仍然只用 7.0。等
typescript-eslint 支持仓库锁定的 TypeScript 版本后，删除这个包。

**每个目录对应一个 TypeScript 项目**（`scripts/lint-projects.ts`）。如果给解析器一个
项目列表，它会按顺序逐个尝试，直到找到包含该文件的项目，途中把每个程序都建出来；
`packages/web-ui` 排在最后，单独 lint 就耗尽了内存。API 的 lint 项目
（`apps/api/tsconfig.lint.json`）把测试也包含进来：`pnpm typecheck` 不检查这些测试
（它们的假对象刻意只实现部分接口，有约 2,000 个类型错误），但 lint 需要它们的类型。

**一个项目一个进程。** ESLint 会把建过的程序一直留到进程结束，七个项目放在一个进程里
约 2 GB 时内存溢出。`pnpm lint:typescript`（`scripts/lint-typescript.ts`）按项目分进程
运行，按内存决定并行数（约每 2 GB 一个，可用 `LINT_CONCURRENCY` 覆盖）。分进程有漏掉
文件的风险，所以运行前先核对：每个被跟踪的 TypeScript 文件恰好属于一个项目，否则直接失败。

## 后果

- 在 `apps/`、`packages/`、`scripts/`、`e2e/` 中新增一个既没 `await` 也没 `void` 的
  Promise 调用，CI 的 `pnpm lint` 会失败（`scripts/lint-policy.test.ts` 有对应用例）。
- `pnpm lint` 变慢：带类型的全仓 lint 在 CI 规格的机器上约 1–2 分钟。
- 格式检查的范围会随批次扩大；每批之后，把它的提交加入 `.git-blame-ignore-revs`。
