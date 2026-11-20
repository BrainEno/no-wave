# 本轮审阅：本机密码文件、Worker 和无损字节复核

## 范围与授权

- 独立基线：`28ca34be4584fb7684b736069abf02a7d208f171`；工作分支 `arena/697c79ba-no-wave`。
- owner 明确批准 `approve-local-encrypted-backup-full`：明确选入单篇备份/集合/三方取舍计划，
  原生 PBKDF2-SHA-256/AES-256-GCM，只在本机人工复核后手动生成副本，口令/密钥不托管。
- 本记录是送审前证据快照；精确 head 的云端 CI、CodeQL、review/blocker、Ready 事件及普通
  match-head merge 在本轮 PR 中分别核验记录，不能把本记录当成已经 Ready 或已经部署。
- [ADR 0047](../architecture/decisions/0047-local-encrypted-writing-backups.md) 记录安全取舍，
  [使用/故障说明](../operations/writing-vault.md) 记录人工流程。

## 可观察行为

1. `/write/vault` 是匿名可用的空壳、no-store、noindex，拒绝 URL 文件/口令输入并重定向
   干净路径。只有精确成功的私有工具文档允许同源 Worker；进出整页导航，其他文档继续
   `worker-src 'none'`。脚本哈希、禁止事件属性和 framing 基线不放宽。
2. 固定有界封装，文件头先预检再读完整密文；所有输入/回解的 backup、collection、plan
   仍用既有严格合同。独立 plan parser 只作语法/自附摘要校验，三方工作台的真实来源、
   角色、条目、当前分析授权不变。普通格式/大小错误不会启动密码计算。
3. 原生 PBKDF2/AES-GCM 和完整 AAD 认证；加密文件手动下载前从实际封装真实回解，逐字节
   比较原 UTF-8（含 BOM/空白/换行）。错口令、认证损坏或认证后非法载荷不输出部分明文。
4. 专用 Worker 版本握手、精确 ID、单槽零队列、取消 terminal fence、10s/120s watchdog、
   严格请求/回应字段和完整 transferable buffer 所有权；故障关闭，无自动重启/重放/主线程回退。
   Native KDF 不能宣称已被取消，迟到结果只清理，不复活输出。
5. 口令不进入 React state、controller 快照、URL、存储、日志或网络；输入框提交前同步清空。
   仅核验在 Worker 内清理明文，只回传闭集数量/摘要回执。更换口令先认证旧副本，再用新随机
   参数产生不同口令的新密文，不生成明文文件、不撤销/删除旧文件。
6. 纯文字复核，不装载图片或链接。原始 JSON 8192-byte UTF-8 安全分页和线性、有界可取消
   的精确字节检索；每次最多 100 个内容无关偏移，达到预算不宣称穷尽。视图不改变文件成员。
   结果独立确认和活对象见证控制手动下载；重新明确选入下载副本，分块逐字节检查完整性。
7. 换文件、口令变化、取消/清除/离页/历史返回撤销旧任务与结果；pagehide 同步清空私密 DOM，
   persisted pageshow 也清空、不自动重读。浏览器测试包含真实导航/历史遍历和合成 persisted
   生命周期，后者不是“已证明实际 BFCache 收纳”的说法。

## 复用检索与改动边界

检索并复用 shared-module index、writing-backup/document/collection、merge-plan、
collection-browser、collection-search/replacement、下载 lease、文稿纯文字组件、私有 HTTP
头和导航 seam。规范 JSON 的旧 checksum 不等于原文件字节摘要；正文语义锚点也不能给出
BOM/JSON 转义的原字节偏移，故新模型是语义不同的必要边界，未复制编辑器恢复或替换算法。

生产代码位于 `packages/web-ui/src/lib/writing-vault-*` 与 authoring 的对应五个组件；
共享 binary reader/download lease 与 standalone plan parser 保留既有调用合同。
Web 侧仅新增路由及有意的 Document CSP 能力隔离、导航接线。没有新运行时依赖、API、数据库
迁移、后台任务、遥测、自动存储或生产配置；既有写作/恢复/三方/API 能力继续保留。

## 行为 RED → GREEN 证据

本机原始日志保存在被忽略的 `verification/writing-vault/`；不把日志或测试计入功能行。

| 行为 | RED | GREEN |
| --- | --- | --- |
| 原生认证、参数、原字节与自检 | `crypto-red.log` | `models-final.log` |
| standalone 计划只校验不授权 | `standalone-plan-red.log` | `models-final.log` |
| binary 原样读取/下载 | `binary-browser-red.log` | `models-final.log` |
| 控制器意图/输出见证 | `controller-red.log` | `models-final.log` |
| 原生换口令 | `rotation-red.log` | `models-final.log` |
| 取消 inspect/控制器换口令 | `rotation-controller-contract-red.log` | `models-final.log` |
| 只有精确私有文档授予 Worker | `csp-scope-red.log` | `csp-scope-green.log` |
| 原字节有界分页/线性检索 | `preview-contract-red.log` | `models-final.log` |
| 迟到搜索和陈旧复核见证 | `preview-controller-red.log` | `models-final.log` |
| 只核验不回传正文 | `verify-only-worker-red.log` | `models-final.log` |
| 文件头有界预检/前缀变化 | `local-file-behavior-red.log` | `models-final.log` |
| 固定预检错误不能被 read 覆盖 | `preflight-controller-error-red.log` | `preflight-controller-error-green.log` |
| 回应协议漂移/隐藏 buffer 拒绝 | `worker-reply-contract-red.log` | `worker-reply-contract-green.log` |

最初 Worker/readback 的 RED 仅 missing module，不冒称算法行为 RED；最初 local-file RED 是
无效 fixture，修正后 `local-file-behavior-red.log` 才是有效行为 RED。曾有 Worker 测试复用
已被擦除的请求导致断言失败，修正测试所有权而未削弱生产清理；曾有预检错误被控制器统一
包装为 read 的真实浏览器失败，已建立单元行为 RED 后修正，最终 8 项浏览器重新通过。

## 本机已执行与环境缺口

- Node 24.22.3 / pnpm 10.20.0，实际 frozen install 成功（502 packages）；没有重写 lockfile。
- 最新定向模型/协议/controller/独立 plan/binary/navigation：**61 pass / 0 fail / 0 skip**，
  `models-final.log`。原生 crypto 含独立 node:crypto 互通，不只测试自己的加解密互相吻合。
- 最新生产构建成功：`build-release-candidate.log`；真实编译的 Worker 是同源独立 asset。
- 最新工具浏览器：**8 pass / 0 fail / 0 skip**，`browser-release-candidate.log`；覆盖离线、
  原字节下载/复读、恶意文字、错误口令/认证损坏/非法参数、只核验、换口令、集合/计划、
  真实迟到 Worker 回复、取消单槽、生命周期/CSP 进出/历史、手机布局/axe、分页/100-hit 上限。
- 本机官方 Playwright Chromium 下载受到出站网络限制，`official-chromium-install.log` 失败；
  真实浏览器证据来自临时安装的 `@sparticuz/chromium@153.0.0`，不进入仓库/lockfile。仅使用
  no-sandbox/dev-shm/GPU 兼容参数，**没有** disable-web-security、忽略 CSP、伪造响应或测试重试。
  官方 Playwright 版本和完整四分片套件必须由精确 head 的云 CI 再验证。
- 较早完整 root：2739 pass / 465 skip / 0 fail；Web：284 pass / 18 skip / 0 fail。
  后续扩展不能借用旧 root 结果冒充最终版本；最终重跑结果在 PR 送审记录补充。
- 已执行 lint、完整 typecheck、format:check、OpenAPI/slices/fonts check、route smoke、
  无邮件发布探针（9/9），但代码扩展后最终静态/完整 root/Web/全浏览器回归仍按精确快照重跑，
  最终结果在 PR 中逐项记载。
- `pnpm audit --audit-level low` 实际 exit 1：现有 dev `@babel/core@7.28.5` 一项 low
  [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8)，0 moderate/high/critical。
  `--audit-level high` 实际 exit 0。未把严格低危审计写成全绿，也未借本轮加密功能擅自扩大依赖升级。
- 本机无 Docker，官方 Chromium 亦缺失，不能声称本机 `test:all`、PostgreSQL 或容器门禁全过。
  云端对应门禁、官方浏览器、CodeQL 和聚合 gate 不能跳过/旁路；生产和跨主机演练未执行。

## 独立有效新增生产行

基线固定为上述 28ca；不是初稿候选 755/1143、中期 657 有效行或旧轮 PR376 的信用。
主核验 `writing-vault-lines.ts` 逐行结合 Babel runtime tokens 与 git additions，自动剔除
imports/re-exports/类型/声明参数/空白标点/静态 JSX，跨**所有基线生产 TS/TSX** 去重和新增
归一化去重；`writing-vault-line-exclusions.json` 再逐行扣静态配置/文案、DTO/props、薄转发、
原代码搬移/改名和独立核验发现的历史/重复 runtime 片段。

仅对新 vault 模型/五个 UI 组件，以及本轮新增的独立 plan 严格校验计算信用。原有三方预览
授权检查的 refactor 不计；路由/CSP/导航/binary 接线、测试、文档、CSS、审计工具、生成物、
格式和构建修复也不计。候选 **1280** − 语义扣除 **467** = **813 有效新增生产功能行**。

[主证书](writing-vault-lines.json)包含逐文件 SHA-256 和行号；
[独立证书](writing-vault-lines-independent.json)使用 **Node TS 擦除 / esbuild TSX 擦除与
source map / Espree tokens**，再次核对源码哈希、确实新增、基线与新增 runtime 去重，
只能扣除、不能补计：**813 / 813，0 failures**。这不是另一个人的安全审计。

证书 SHA-256：`0a845d39104be7678f610f2daa17978df9dbb967aafa4a310361f618d916261e`。
重跑：`node docs/audit/writing-vault-lines.ts`，输出应与主证书一致；
`node docs/audit/verify-writing-vault-lines.ts` 应再次确认当前文件，不接受过期哈希。

## 安全结论与保留项

这轮只增加本机手动密码副本功能，未加入自动持久化/上传/编辑区/服务器写入或外部脚本。
口令不可恢复、旧副本/原明文仍存在、同源脚本/扩展可窃取使用中数据、内存非物理擦除等风险
已在界面、使用说明和 ADR 明示。下载不证明落盘，认证/摘要不证明作者或业务授权。

diff 不含真实账号、口令、secret、生产数据或生成字体/浏览器二进制；密码测试全部是显式
fixture。本轮未访问已连接的 Docs/Drive/Notion 内容。部署、secret rotation、自动修复和
请求重放没有授权；#331、ADR 0026/0041–0043 继续独立。只有全门禁与精确 head/base 审阅后
才单独 Ready，再按已授权的普通 match-head merge 流程操作，不使用 auto/admin/bypass。
