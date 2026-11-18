# 构建工具的非递归 glob 适配器

此包是私有的 `@bot-thk/glob-match@0.0.0`，**不是 picomatch 的新版本或改名发行版**。
它用 `minimatch@11.0.9` 拆分路径，由
`@isaacs/nonrecursive-glob-match@1.1.0` 的状态机匹配路径片段；没有复制
picomatch 的 parser、正则编译器或漏洞补丁。`scan.ts` 只生成路径扫描元数据，
不执行、不扩展 glob，也不生成正则。

## 使用边界

仅供当前仓库的 Vite、tinyglobby、fdir、fast-glob、micromatch、Prettier 和
Playwright 工具链使用；不是新的业务层公共模块，也不进入浏览器包。
`pnpm-workspace.yaml` 的 `picomatch` override 保留调用者的旧模块解析键，
实际解析到本包的真实名称和 `0.0.0` 私有版本。原来两个官方 picomatch
发行物已经从锁文件的 packages/snapshots 删除；没有伪造“官方安全版本”。

新增依赖的许可证：minimatch 为
[BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0)，非递归片段匹配器为 MIT。
两者均为纯 JavaScript、无原生构建要求；项目继续固定 Node 24 / pnpm 10.20.0。
锁文件固定完整性摘要，不依赖浮动 Git 分支或安装时下载源码。

## 工具协议，不是完整的 picomatch 兼容层

保留当前调用者需要的：

- 字符串/数组匹配；brace、globstar、POSIX class、extglob、否定；
- `dot`、`nocase` / `flags: "i"`、Windows 路径、`matchBase` / `basename`；
- `nobrace`、`noext` / `noextglob`、`noglobstar`、`nonegate`、`strictSlashes`；
- `ignore`、`format`、有序 `onResult` / `onIgnore` / `onMatch`；
- micromatch 使用的 `.state.negated` / `.state.negatedExtglob` 与结果对象；
- `scan` 的 base/glob/parts/tokens，以及本包自己生成的 parse/compile 状态。

兼容规则显式保留：普通 literal 不接受额外尾斜杠；不删除待匹配路径的
`./` / `../`；尾部 `/**` 可匹配目录本身；前导否定 extglob 的 dot 规则按
**单个片段**适配，不能因此让 globstar 遍历隐藏父目录。

名字沿用的 `makeRe` 返回 **predicate，而不是 RegExp**。它的 `test` 和 `exec`
都使用状态机；`source`、字符串转换和要求正则源码的返回模式明确抛错，
防止下游重新构造回溯正则。`exec` 只返回完整匹配，不承诺捕获组。
`parse` 返回本包的语义状态，不是 picomatch 的正则输出 AST。

`capture`、`regex`、`bash`、非空 `prepend`、自定义 `expandRange` 及非 `i` flags
明确拒绝；默认 glob 采用新引擎的 Bash 路径语义，**不支持原库额外接受的
任意原始正则语法**。不要把本包作为通用 picomatch 库发布或承诺其完整 API。
外部工具升级或新增 glob 选项时必须重新检查调用协议，不能通过添加不安全的
正则 fallback、返回假匹配结果或跳过测试来扩展兼容性。

工具配置的工作量预算：pattern 最多 65,536 字符、brace 展开最多 1,000 项；
`contains` 使用最多 512 字符的有界子串搜索及独立工作量预算。字符类构造也有
保守的 1,000,000 后缀扫描预算，在展开前及片段编译前检查；因此某些包含大量
合法字符类的配置也可能被拒绝，转义的字面量括号不计入该预算。超出时抛错，
不截断、不当作“不匹配”或成功。这些是工具配置边界，**不修改 API / 文章 /
媒体 / 导入导出 / 业务限额**。状态机不编译整条 glob 的回溯正则；字符类和
Unicode 大小写仍使用单字符或已转义字面量的正则。它并不承诺任意超大输入、
插件函数或所有多项式工作量都没有拒绝服务风险。

## 为什么还需要三个补丁

- `vite@8.3.6`：有自定义 `assetsInclude` 时不把 glob 转成 native RegExp
  前置过滤器，直接进入原有 `config.assetsInclude` 权威判断；默认资源仍保留
  native fast path。非匹配文件仍不能作为自定义资源被接受。
- `prettier@3.10.0` / `playwright@1.65.0`：它们包含私有打包的 picomatch。
  只替换锁文件不能改变这些执行入口，补丁将 bundle 的匹配出口导向本包；
  原 bundle 中未调用的编译器文本不构成备用执行路径。packageExtensions
  显式声明其真实新增依赖，不依靠偶然的根目录 hoist。

补丁使用 pnpm 的 hash 锁定与 frozen install，**没有修改依赖审计命令、报告、
severity、registry、忽略项或 CI 门禁**。当前 fdir 的可选 peer 仍会报告旧包名
范围警告；没有把本包版本伪装成 `3.x` / `4.x` 来消除它，真实 fdir API 有回归测试。

## 验证与维护

```sh
pnpm install --frozen-lockfile
pnpm audit --audit-level high
node --test scripts/glob-engine.test.ts scripts/glob-consumers.test.ts
node --test apps/web-rr/test/glob-assets.test.ts
pnpm lint
pnpm typecheck
pnpm build
pnpm test:all
```

测试分别保护 predicate/回调协议、真实文件遍历与排除、Prettier bundle 实际执行、
Playwright bundle 出口、Vite 自定义资源和真实 HTTP 私有文件拒绝。
跨引擎差异、隔离安全验证及最终 CI 状态见
[本次复核](../../docs/audit/glob-engine-replacement.md)。第三方完整 API 测试不等于
本项目协议测试；已确认的非目标兼容性差异必须如实报告，不得声称完整兼容。

官方安全发行版可用后，应另做依赖回归再撤销 override、三个补丁和本包；
不能仅因 audit 名称匹配变化而移除安全测试。此变更不授权部署或合并。
