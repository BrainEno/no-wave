# #368：用不同匹配引擎修复依赖审计阻塞

## 决策与边界

用户选择“评估真正的替代实现”。原 CI 的两个失败项为 `verify` 的全锁文件
high 审计及其依赖的 `required-checks`。PR #367 在最终 head 全部检查通过前
保持 Draft；本次不创建替代 PR、不合并、不部署。下文为提交前本地证据，
最终远端状态另在 PR 记录，不能拿旧 head 的检查认证新提交。

官方 picomatch 2.3.2 / 4.0.7 受 GHSA-fc5q-39xc-vjpf 影响，调查时没有官方
修复发行版。固定未合并提案的真实源码、保留真实版本，审计仍然失败；
不能通过假包名、假安全版本、忽略 advisory 或削弱 CI 来解决。

本次实际移除其可达匹配执行实现，新增真实私有工作区
`@bot-thk/glob-match@0.0.0`，以 minimatch 11.0.9 / 非递归片段匹配器 1.1.0
执行匹配。旧 `picomatch` 仅作为调用者模块解析键，不是本包身份。
没有采用检查不充分的第三方 picomatch fork，也没有复制原正则编译器。
许可证、资源预算、API 差异与三个必要补丁见
[包说明](../../packages/glob-match/README.md)。

## 复用与风险检查

已检索 shared-module index、原 micromatch / tinyglobby / fdir / Vite 调用者、
Prettier / Playwright bundle、原审计策略与 Docker manifests。
现有 web-http / web-ui 负责 HTTP 或产品逻辑，不负责构建工具匹配，不能把
新实现放入这些运行期公共边界或复制 BFF 策略。

风险为高：涉及目录发现、排除规则、Vite 私有文件拒绝及工具 bundle。
没有变更业务/数据库限额、Cookie/actor/revision、集合流式读取、物理租约、
导入事务或部署别名。唯一容器改动是复制 frozen 安装需要的真实工作区文件。

- `makeRe` 不再返回整条 glob 的正则，且禁止取 source / 字符串化；无回溯 fallback。
- 真实文件遍历验证了正向、否定、dot、转义括号、中文路径及 fdir dot 默认值。
- Vite 自定义资源补丁只改变预分发优化，handler 的权威匹配不变；有正反测试。
- 真实 Vite HTTP 验证 `.env`、证书和 `.git` 仍被拒绝，普通文件仍可读取。
- Prettier / Playwright 的私有打包匹配出口也替换，不只让锁文件审计看不到原包。
  静态检查确认两个 bundle 的旧 parser/compiler 在原定义块外没有引用；
  Prettier 复用的路径工具只含固定正则，不是原 glob 编译器。
- Prettier 实际 config override 会调用新引擎。Playwright 两个内部 Jest helper
  在原安装 bundle 上加隔离出口探针，实际执行有序否定、全否定与堆栈路径匹配；
  确认两处都调用新引擎。它们不是 Playwright 的公开导出，不能把内部探针冒充
  完整浏览器测试；完整标准浏览器矩阵仍单独验收。
- 新包为纯 JS 依赖 + TypeScript 适配，Node 24 直接读取真实工作区源文件；
  容器复制 manifest、patches 和必要源文件，保持单锁文件 frozen 安装。
- fdir 可选 peer 仍有身份/范围警告；保留真实 `0.0.0`，没有抑制或伪造版本。
  真实 fdir 的默认 dot 和显式 dot:false 均有文件发现回归。

## Red → Green 与资源验证

- 原模块的非正则 predicate 断言失败；替换后通过。
- Vite 自定义资源在直接替换后失败；最小 native-filter 适配后正反测试通过。
- 原 Prettier bundle 未执行新引擎的断言失败；bundle 补丁后通过。
- 差异对比发现 dot 前缀、literal 尾斜杠和否定 extglob 的 dot 规则差异；
  保留原语义后回归通过，没有放宽隐藏父目录遍历。
- 额外构造压力发现字符类反复扫描的超时。先补预算测试确定性失败，再增加
  展开前/片段编译前的保守成本检查；同一隔离超时用例现在明确抛 RangeError。
  没有用返回 false、截短配置、恢复旧引擎或降低业务限额来隐藏失败。
- 隔离 matching 压力 14 组全部完成；额外构造/路径/contains 13 组为 8 组完成、
  5 组明确拒绝超额配置，最终 0 timeout。每个子进程有 deadline，后者另有
  128 MiB V8 heap 上界；未在公共提交中包含可武器化输入。
  这些是有限样本和预算回归，不是任意 glob 的复杂度证明。
- 有效生产功能行数双程序证书仍为 **802 / 802，0 失败**。此次依赖、工具
  适配、测试、文档与配置均不重复计入既有业务功能交付，不据此膨胀行数。

## 兼容性声明（不是全 API 兼容）

未经修改的 micromatch 上游套件实际为 **1,954 测试：984 pass / 970 fail /
0 pending**。970 项中 769 项为明确拒绝的 regex/capture/bash/custom-range
接口，199 项为其他语义或输出差异，2 项为错误文字差异。**这个套件没有通过**，
没有跳过失败用例，不能把 970 项统称为无关或声称完整 picomatch 兼容。

剩余差异包括原始正则表达式、跨斜杠 class/extglob、未转义括号的字面量回退、
部分否定 extglob 组合、尾斜杠以及 Windows 结果格式。适配器仅供当前内部工具
协议；不发布为通用库、不承诺任意新配置相同。Windows 显式选项有局部单测，
但本轮未在真实 Windows OS 上验证完整工具链。

实际 lint / typegen / build / formatter / 回归调用采集了 77 组引擎编译配置；
在当时 4,075 个 Git 跟踪/合成路径上完成 **313,775 次对比，0 差异**。
本项目的文件发现、回调状态、两处 bundle、Vite 拒绝路径及完整业务测试分别
验证实际可达协议。新增依赖或配置如需未支持的 API，必须重新评估，不能
偷偷恢复正则编译或伪造 source / captures。

## 提交前本地验证记录

| 检查 | pass | fail | skip | 说明 |
| --- | ---: | ---: | ---: | --- |
| 引擎/真实调用者/Vite/容器配置定向测试 | 19 | 0 | 0 | 含 bundle 运行探针、HTTP 403 / 200、字符类预算 |
| 最后一次完整 `pnpm test` | 2385 | 0 | 450 | 总 2835；PG 分支不当作通过 |
| 真实 PostgreSQL integration | 743 | 0 | 0 | PG 17.11，含默认三角色通知、真实双 Web 刷新 |
| build 后完整 Web behavior | 281 | 0 | 18 | 总 299；PG 分支由上一行单列覆盖 |
| 本地非标准 Chromium 分片 1 | 60 | 0 | 0 | retries=0；包含 #366 的大集合完整浏览器旅程 |
| 本地非标准 Chromium 分片 2 | 66 | 1 | 0 | 评论编辑器填写后显示“内容不能为空”，并非通过 |

root 曾在与浏览器/类型检查并行负载时发生一次既有 40 ms fixture deadline
超时；**未修改该限时或任何断言**，随后独立完整重跑为上表结果。
浏览器分片 2 的失败保留原始日志/错误上下文，剩余本地分片当时未运行；
没有凭第一片通过就报告完整浏览器成功，标准 Playwright 构建由最终 CI 验证。

另已实际 exit 0：lint、完整 typecheck、scoped format、production build、
routes、OpenAPI、工作区 frozen install。干净离线 frozen 安装矩阵的 root /
Web prod-filter / API prod-filter 全部 exit 0，锁文件摘要不变；fresh root
确认真实 matcher 身份和 Prettier 补丁，另一次 Web build-filter 安装也通过。
这些安装探针不是 Docker 镜像执行的替代品。

原 CI 命令 `pnpm audit --audit-level high` 实际 exit **0**；完整图共 597 项，
**0 critical / 0 high / 0 moderate / 1 low**，原 Babel low 未变。带 `--json`
的诊断输出仍 exit 1（有 low），如实保留；没有将 JSON 命令结果冒充门禁通过，
原门禁就是不带 JSON 的完整审计命令，未改任何 audit 策略或 CI 配置。

`pnpm test:all` 本地尝试未通过 preflight：缺少 Playwright 官方下载的 Chromium；
沙箱也无 Docker。未声称本地完整隔离命令、镜像、CodeQL、标准浏览器或最终
head CI 已通过。最终 head 真实 required-checks 和全部检查通过前，PR 保持 Draft；
本地结果及之前 `077aa029` 的 15/17 绿灯都不是最终验收。
