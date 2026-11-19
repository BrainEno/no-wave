# #331 公钥-only 历史证据审阅：审阅与验收记录

本轮基线为 `a4e9de38a36387dd7b1314b5eae177d96041dbe3`，工作分支
`arena/f3886e22-no-wave`。基线已含 PR #371；不累计上轮 822 行或借用其 CI。
本轮范围已由 owner 明确批准，见 [ADR 0044](../architecture/decisions/0044-public-only-alert-evidence-review.md)。
完整输入、语义、错误及恢复边界见[操作规程](../operations/alert-evidence.md)。

## 本轮行为与文件边界

| 任务                   | 主要生产模块                                                                                              | 验收边界                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 固定独立公钥与有界清单 | `infrastructure/alert-evidence-{config,manifest,file}.ts`、`application/alert-evidence-authentication.ts` | closed schema、同一 receiver、多来源唯一 pin；原始 digest、私有稳定非阻塞读、安全路径、控制/产物不得 alias、全量接纳后才输出    |
| 跨批次与多来源历史审阅 | `application/alert-evidence-{history,episodes,receipts,review}.ts`、`alert-evidence.ts`                   | gap/conflict/warning 分开；fork/回退/重放、episode 片段、匹配/歧义回执、源/全局时序和签名 sequence 接收下界；缺历史不伪装空尾部 |
| 保留旧事实的集合比较   | `application/alert-evidence-compare.ts`                                                                   | 两侧与并集独立审阅；删除/替换不算进展，不凭新干净子集消除旧 fork                                                                |
| 独立已知 checkpoint    | `application/alert-evidence-requirements.ts`                                                              | 精确 batch/可选 receipt，point/有界签名前驱 prefix；要求不能来自候选 manifest，也不自认证                                       |
| 有界定位与全部发现导航 | `application/alert-evidence-{query,context,trace}.ts`                                                     | 精确 batch/event ID、来源/时间/序号/视图过滤；只描述已提供的同规则邻居/链接/回执；全局问题与退出码始终保留                      |
| 有限只读入口           | `infrastructure/alert-evidence-command.ts`、API package script                                            | `ops:evidence` 的 review、compare、check、trace 四种模式，退出码 0/1/2/3，有界输出/取消；无 `.env`、网络、业务 store、锁或写入  |

测试位于对应 application/infrastructure `alert-evidence*.test.ts`，合成身份及私有
临时目录在 `infrastructure/test-support/alert-evidence-{fixture,workspace}.ts`。没有真实
账号、事件、私钥或用户数据进入仓库。文档修改仅为新 ADR、规程、共享索引与现有
API/交接/phase gate 导航；不关闭 #331，不改变既有 v1 产物或业务行为。

## 决策、复用检索与风险

先查 `AGENTS.md`、phase gate、shared-module index、ADR 0042/0043；实际检查
`alert-handoff-{protocol,verification,reader,reconcile,inbox,sender}.ts` 的实现、调用和
测试，以及 `alert-handoff-{config,file,command}.ts`、monitor 模块、
`private-operation-file.ts`、`operation-command-output.ts`、`entrypoint.ts`。

- 直接复用原 Ed25519 域分离、事件/schema/profile 解析、receipt 验证和 hash。
  不复制第二份签名算法，不接受产物自带的 key，不向审阅方分发私钥。
- 复用 POSIX ownership/permissions/single-link/NOFOLLOW/NONBLOCK 读取和有限输出；
  新文件层只追加清单 containment、原始 digest、每侧总预算及保守稳定复读。
- inbox reader 需要接收方私钥与 inbox 快照，不适合公钥-only 归档。新 unsigned
  navigation 明示不是授权，绑定规范化已验签集合/查询/结果，不能确认或消费。
- 旧 verify 处理单批次；新政策处理有界集合、独立预期和保留旧证据的比较，不能用
  一个“签名正确”布尔值代替跨事实矛盾。没有新 REST/BFF/UI 或业务持久化职责。

风险等级：只读副作用低；不可信输入、证据含义、错误脱敏与资源边界为高风险验证点。
曾在未补齐 product-decision gate 时先写草稿，发现后停止提交/PR/merge，明确提供
三种范围选择；owner 选择“批准完整只读范围”后才继续。本轮批准不追认其他产品或
运维动作，以后仍须执行单独决策门禁。

## 行为优先回归与实际故障

最初新增模块的 RED 中有缺模块 loader 失败；这不能冒充已执行的行为失败。随后
check/trace 的入口拒绝、独立要求缺失/alias/改写，以及新回归均实际观察到断言失败，
再实现并重跑。原测试和 CI 阈值没有删除、skip、放宽或绕过。

重点保护：

- 不受信任/被篡改产物、公钥/角色替换、私钥字段、未知字段、错误 UTF-8、未来时间；
- 真实 8 MiB 聚合预算（重复也计 raw bytes）、8192 唯一事件包含边界及下一批拒绝，
  超额文件不被打开；比较两侧预算独立，不按巨大 sequence 展开循环；
- 证据 fork/替换/删除、跨批次 episode 断点、接收方全局顺序、超过安全整数范围的
  sequence 接收下界，以及没有 batch 时同来源 terminal event 的签名重放声明；
- 独立要求的精确匹配/连通前缀，hash 不构成信任，候选清单不能自己选择要求；
- 全量验签先于选择，空过滤/窄范围/伪造现存导航位置都不能让全局问题变绿；
- 139 项发现跨过全局 128 条样本后仍能完整分页，数据/trust/选择/limit 改变使页失效；
- 完整回执关联不受每事件 4 份显示样本限制；缺少来源历史保持未知尾部，旧 orphan
  receipt 的年龄不能被新事件掩盖，矛盾签名不计无歧义声明；
- 实际 v1 prepare/receive/settle/profile 生产者输出，在删除全部合成私有日志/key 后，
  由独立进程执行四种只读模式和分页；并发读没有 writer 锁或文件变化；
- 真实 trust/manifest/artifact FIFO 非阻塞拒绝，真正塞满 stdout 后有限退出并保留
  原文件；跨读 pass 的 trust/manifest/artifact/requirements 改写失败关闭。

没有独立验证当前证据命令的进程 SIGTERM/SIGKILL/native I/O 中断恢复、升级/回滚、
跨主机搬运、同 UID 恶意竞争、NFS/Windows 或真实磁盘断电；不可把边界取消测试、
合成文件改写、旧协议演练或回执签名当成这些证明。

## 本地完整验收

在最终生产源码（含 `receipt_event_replayed`）上，使用 Node **24.22.3**、pnpm
**10.20.0**，实际执行并检查下列输出。命令中的数据库仅为本地一次性 PostgreSQL
**17.11**；测试完成已停止，不访问任何生产或开发者数据库。本地日志在忽略的
`verification/alert-evidence/`，一次性工具/数据库与大日志不提交。

| 实际执行                                                                        | 结果                                     | 证据与限制                                                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                | exit 0                                   | 锁文件未变，无新增依赖                                                                              |
| application / infrastructure `alert-evidence*.test.ts`                          | **56/56**，0 skip                        | 含新 terminal replay 的 RED→GREEN；真实 producer/FIFO/满 stdout 在内                                |
| `scripts/adr-index.test.ts`、`scripts/doc-evidence.test.ts`                     | **26/26**，0 skip                        | ADR 连续编号、状态、全部仓库 Markdown 本地链接                                                      |
| `pnpm test`                                                                     | **3057 项：2592 pass，465 skip，0 fail** | 未设 `TEST_DATABASE_URL`；skip 不伪报通过，另跑下列真实 PG 组                                       |
| `pnpm lint`、`pnpm format:check`                                                | 均 exit 0                                | 全仓现有 CSS / TypeScript / format 门禁不变                                                         |
| 新增生产/测试 TypeScript、fixture、audit 程序的额外 Prettier check              | exit 0                                   | 不扩大或削弱原 format scope                                                                         |
| `pnpm typecheck`、`pnpm build`                                                  | 均 exit 0                                | 全 workspace 类型与生产 Web build，非只检查新增模块                                                 |
| `pnpm test:routes`                                                              | exit 0                                   | 既有路由 smoke                                                                                      |
| `pnpm --silent verify:publish --json`                                           | exit 0                                   | 一次性、无邮件服务的实际发布可见性验证                                                              |
| `pnpm test:web`                                                                 | **299 项：281 pass，18 skip，0 fail**    | 未配置 PG 的生产 Web 组                                                                             |
| 设置一次性 `TEST_DATABASE_URL` 后 `pnpm --filter @bot-thk/api test:integration` | **774/774**，0 skip                      | 真实 PG；包含双 Web 协调/默认三进程通知链与故障行为，不把错误注入日志误记失败                       |
| 同一一次性 PG 下 `pnpm --filter @bot-thk/web-rr test`                           | **299/299**，0 skip                      | 生产 bundle，补跑 Web 的 PG 行为                                                                    |
| 文档示例 smoke                                                                  | exit 0                                   | 实际复制规程的 manifest 生成 shell、包命令 help，以及四种独立进程；无私钥输入，调用前后文件字节不变 |
| `pnpm openapi:check`、`pnpm slices:check`                                       | 均 exit 0                                | 既有 REST 合约和持久层所有权/生成清单无漂移                                                         |
| 两份生产行审计                                                                  | 均 exit 0                                | 当前精确文件 hash；**804/804**，详见下节                                                            |
| `pnpm audit --audit-level high`                                                 | exit 0                                   | **不等于零依赖告警**；全量 `pnpm audit --json` exit 1，详见下述已知事项                             |

依赖全量 inventory 有 **1 low，0 moderate/high/critical**：基线已有开发依赖
`@babel/core@7.28.5`，`GHSA-4x5r-pxfx-6jf8`（sourceMappingURL 任意文件读取；
通告修复范围 `>=7.29.6`）。本轮不加载该模块处理证据、不修改依赖/锁文件；独立
追踪依赖升级，不以 high 阈值通过宣称零漏洞，保留该 low 风险记录。

本地没有 Docker/Chromium，且受出站下载限制，故没有运行本地容器镜像 smoke、
Playwright 浏览器组或拥有 Docker 的整套 `pnpm test:all`；独立
`pnpm perf:baseline`、双 provider `stack:check` / `dev --check` 也未作为单独命令
重跑。这些对应的最终源提交远端 jobs（包括四个 E2E shard、container、
full-local-suite、performance-baseline）仍必须全成功后才可进入下一操作。
本地单元/PG 的真实进程链不代替那些 job，更不构成生产主机资格。

逐模块审阅生产实现和受控文件差异；40 个变更文本文件的常见 credential literal
启发式扫描无命中（不把正则扫描当成零泄密保证），`git diff --check` 通过。身份/key
只在测试进程内合成，夹具不含固定真实密钥；没有发现无关改动或真实凭据。

## 新增有效生产功能行

基线固定为本轮 `a4e9de38`，仅看生产 TypeScript 的新增可执行 token 行，排除
空白/注释/标点、import/类型/签名、静态配置/help/schema、纯 DTO/参数转发、全仓
基线历史片段与新片段重复，以及手工语义账本。测试、fixture、脚本、文档、生成物、
package 接线一律不计；整个有限 CLI 入口也保守扣成 **0 行**，不以换名的 codec、
SPKI/base64 或既有解析器薄调用补足门槛。

最终生产证书：**1504 候选 − 700 语义扣除 = 804 行**。独立 Node 24 类型擦除 +
Espree 核对 **804/804，failures=[]**。曾得到不足门槛的 646/795/797，不降低 800
门槛、不回收扣除；补齐已批准范围内实际暴露的源接收下界、orphan 年龄/terminal
重放等缺口后重新审计，而不是加入无关任务或测试/文档凑行。

- [主计数程序](alert-evidence-lines.ts) / [逐行证书](alert-evidence-lines.json)
- [逐片段语义扣除账本](alert-evidence-line-exclusions.json)
- [独立核对程序](verify-alert-evidence-lines.ts) / [核对证书](alert-evidence-runtime-check.json)
- 证书 SHA-256：`7a85dcd7577973d1789f604db6fa12fe492a3726478fe70e441ab906798ff4ca`

复现：Node 24 下执行 `node docs/audit/alert-evidence-lines.ts`，然后
`node docs/audit/verify-alert-evidence-lines.ts`。程序绑定精确 baseline、生产文件 hash、
具体扣除行文本和 git 新增行；独立程序不在失败时偷偷补行。以往轮次证书仅是其原
source commit 的历史证据，不把当前文件 hash 替代旧轮次。

## 远端门禁与操作边界

最终提交 push 的 CI/CodeQL 全成功后才开 draft PR，再核对独立 pull_request event
的同一源提交、每个 job、合并冲突和阻塞；逐项链接/结果记录于中文 PR 说明与审阅
评论。owner 已授权全部 CI 通过后先 Ready for review，再直接 merge，不使用 auto、
admin 或绕过保护。此前 PR #371 已完成，不对旧 PR 重复 Ready/merge，也不借用旧
SHA 的绿灯。若最终源提交变化，相关门禁必须重跑。

本轮绝不 ack monitor、consume inbox、settle、改 journal、重放、自动修复、部署、
改 DNS/基础设施、运行生产迁移或配置真实账号。签名历史和 checkpoint 不证明当前
健康、通知到人、未见尾部不存在或物理持久性。#331 的真实宿主、持久盘、跨主机传输、
外部通知、watchdog、时钟、key rotation/保管、备份恢复/回滚及其余 Phase gates 仍开放。
