# 阶段门剩余条目归属（#331）

Status: active

本文件为 [phase-gates.md](phase-gates.md) 中 25 条未勾选条目给出归属。
它只说明每条属于哪一类、依据是什么、建议怎么处理；**不勾选任何条目，也不构成裁剪**。
“正式裁剪归档”须由负责人批准后，才能在 phase-gates.md 中改写。

与 #331 验收标准的对应：

- 标准 1（真实托管资格验证、回滚演练、指标留档）：未完成，属于 C 类，需要真实账号与主机。
- 标准 2（可执行的告警规则，覆盖 HTTP 5xx、Outbox 积压/死信、数据库健康、邮件投递失败）：仓库内已满足，见 [运维监测](../operations/operational-monitor.md) 第 3 节与 `pnpm --filter @no-wave/api ops:monitor`。该命令只做有限只读检查，不接外部告警服务，不代表生产已部署。
- 标准 3（明确剩余 25 项的归属）：本文件即为归属记录，裁剪须待负责人批准。

分类定义：A 仓库内可直接推进；B 需要负责人决定；C 需要仓库外资源；D 已部分覆盖，剩余部分归入 B 或 C。

## A. 仓库内可继续推进（无需负责人决策）

- 第 1 项（phase-gates 第 25 行）：Complete the feature-by-feature traceability inventory and record unresolved product behavior.
  - 归属：A 仓库内可推进
  - 说明：仓库内可推进。无对应 issue，需先开 issue。建议：在 docs/audit 中逐功能列出清单，未决的产品行为单列并标注需要的决策。
- 第 6 项（phase-gates 第 66 行）：Add round-trip, malformed-payload, security, Chinese IME, accessibility, keyboard and mobile tests.
  - 归属：A 仓库内可推进
  - 说明：仓库内可推进，下一轮候选。Lexical 往返、畸形载荷、安全与移动端用例可直接写入 e2e/单元测试；中文输入法（IME）组合事件可用 Playwright 模拟，真实输入法仍需人工抽检。键盘操作与短窗口已补齐：文章编辑器的格式条只用键盘即可完成加粗，评论编辑器的字形也能只用键盘完成并到达已发布的内容，窄窗口（390×420）下文章编辑器的光标不再被发布条压住、评论框仍可提交（e2e/editor-contract.spec.ts、e2e/comment-formatting.spec.ts）；尚未覆盖的是评论编辑器自身的 IME 组合事件与真实输入法的桌面抽检。
- 第 10 项（phase-gates 第 79 行）：Eliminate remaining config/runtime gaps and add API/Web contract checks.
  - 归属：A 仓库内可推进
  - 说明：仓库内可推进，但范围未定义。建议先盘点剩余配置与运行时缺口（列出具体变量与路由），再决定是否拆成独立 issue。
- 第 12 项（phase-gates 第 105 行）：Verify Web/API end-to-end behavior with real authentication, including reconnect/offline recovery.
  - 归属：A 仓库内可推进
  - 说明：仓库内可推进。注册与登录的真实会话已在 e2e 中使用。通知的“返回在线”重连已有用例（e2e/notification-sync.spec.ts 等）；通知在真实离线（setOffline）下的失败与恢复由 e2e/notification-offline-recovery.spec.ts 覆盖，使用真实认证与真实通知，并已连续 3 次通过。其余模块的离线覆盖未逐项核对，仍需按同一方式补充。
- 第 21 项（phase-gates 第 139 行）：Complete SEO, sitemap, accessibility and PWA behavior after data/persistence contracts stabilize.
  - 归属：A 仓库内可推进
  - 说明：部分可推进：sitemap、hreflang 与可访问性检查可在仓库内补充；PWA 是否需要属于产品决策，归入负责人决定。

## B. 需要负责人决策（产品门禁或架构决策）

- 第 2 项（phase-gates 第 28 行）：Complete email verification, recovery, browser storage, operational hardening and Web authentication before production use.
  - 归属：B 需负责人决定
  - 说明：门禁总条目，不单独实施。关闭条件分散在 #415（发布门禁）与 #418（草稿恢复）以及运维项中；建议负责人指定“生产前”的具体清单后再逐项关闭。
- 第 3 项（phase-gates 第 47 行）：Select and validate SSE/WebSocket only for concrete real-time needs; keep database/outbox state authoritative.
  - 归属：B 需负责人决定
  - 说明：需负责人确认是否存在具体的实时需求。目前没有已批准的实时场景；建议保留，待需求出现后再选型。
- 第 4 项（phase-gates 第 60 行）：Add registered custom-image node/upload support and preserve additional Lexical metadata only after its application document contract is approved.
  - 归属：B 需负责人决定
  - 说明：依据产品门禁（文档契约需先批准）。建议保留，批准后再实施。
- 第 5 项（phase-gates 第 63 行）：Complete durable recovery of unsaved drafts across page refresh or navigation. The editor only offers in-page recovery for an unconfirmed request; it warns the writer not to refresh.
  - 归属：B 需负责人决定
  - 说明：跟踪 #418（P2，已阻塞）。需负责人决定草稿存储位置与保留期，之后才能实施。
- 第 7 项（phase-gates 第 76 行）：Implement the MongoDB adapter against the shared port contract, including transaction/outbox semantics.
  - 归属：B 需负责人决定
  - 说明：ADR 0010 将 MongoDB 列为未来适配器。建议由负责人决定：正式裁剪归档，或延后到需要时再做。
- 第 8 项（phase-gates 第 77 行）：Complete cross-provider contract parity for all domain operations and provider-specific failure behavior.
  - 归属：B 需负责人决定
  - 说明：拆分为两部分：PostgreSQL 与 SQLite 之间的契约一致性可在仓库内推进；涉及 MongoDB 的部分随第 7 项决定。
- 第 9 项（phase-gates 第 78 行）：Implement online change capture, target replay/checkpoints, reconciliation and fenced provider cutover; a configuration-only switch is not a live migration.
  - 归属：B 需负责人决定
  - 说明：依赖写入权威与 RPO/RTO 决策（ADR 0010）。在负责人批准前不实施。
- 第 11 项（phase-gates 第 92 行）：Confirm product rules for tag deletion/moderation and category creation/ownership before expanding those behaviors.
  - 归属：B 需负责人决定
  - 说明：需负责人确认标签删除/审核与分类创建/归属的产品规则。与 #415（举报与申诉链路）相关。
- 第 14 项（phase-gates 第 107 行）：Design cross-engine change capture/checkpoints and recovery after the write-authority and RPO/RTO decisions are approved.
  - 归属：B 需负责人决定
  - 说明：依赖写入权威与 RPO/RTO 决策，与第 9 项相同，需先批准。
- 第 19 项（phase-gates 第 137 行）：Complete the core feature parity journey and its independent acceptance.
  - 归属：B 需负责人决定
  - 说明：需负责人定义“核心功能对等”的验收范围与独立验收人。
- 第 20 项（phase-gates 第 138 行）：Apply the approved Cloud design artifacts to layouts, tokens, components and responsive behavior.
  - 归属：B 需负责人决定
  - 说明：需负责人确认 Cloud 设计产物的位置与范围；与 #416 中未决的设计偏差一并处理。
- 第 23 项（phase-gates 第 150 行）：Decide whether any historical data import is desired and approve a separate runbook before execution.
  - 归属：B 需负责人决定
  - 说明：需负责人决定是否需要历史数据导入；若需要，必须另行批准 runbook，之后才能执行。
- 第 24 项（phase-gates 第 151 行）：Design HA inside the chosen primary engine first; add cross-engine warm standby only after consistency/fencing rules are approved.
  - 归属：B 需负责人决定
  - 说明：按 ADR 与阶段门要求，须先在主引擎内设计 HA；跨引擎热备需一致性与 fencing 规则获批后再做。
- 第 25 项（phase-gates 第 152 行）：Add React Native/Tauri clients only after API/auth contracts stabilize.
  - 归属：B 需负责人决定
  - 说明：未来项。需负责人决定是否延后或裁剪；前提是 API/认证契约先稳定。

## C. 需要外部资源（真实账号、真实主机或外部服务）

- 第 13 项（phase-gates 第 106 行）：Choose and configure any external Web Push/email provider only after requirements and credentials are approved.
  - 归属：C 需外部资源
  - 说明：需要真实的外部 provider 账号与凭据，且须先获得负责人批准。仓库内不能完成。
- 第 16 项（phase-gates 第 119 行）：Qualify at least one actual hosting candidate for zero cost, no credit card, public access, supported Node SSR and persistent-data/worker requirements before selecting a final host.
  - 归属：C 需外部资源
  - 说明：需要真实的托管候选账号，核实零成本、无需信用卡与公网访问。仓库内不能完成。
- 第 17 项（phase-gates 第 125 行）：Validate the selected host's actual signup/payment conditions, sleep/recovery behavior, database durability, object storage and worker execution before deployment.
  - 归属：C 需外部资源
  - 说明：依赖第 16 项选出的真实主机，验证注册/付费条件、休眠恢复与持久存储。仓库内不能完成。
- 第 18 项（phase-gates 第 126 行）：Complete route/E2E/build/typecheck/PostgreSQL integration regression and rehearse rollback before any traffic cutover.
  - 归属：C 需外部资源
  - 说明：回归测试可在仓库内运行（CI 已覆盖大部分）；回滚演练需要真实环境，仓库内不能完成。

## D. 部分已覆盖（剩余部分需要外部资源或决策）

- 第 15 项（phase-gates 第 109 行）：Complete delivery observability and failure-recovery acceptance, including queue-depth metrics, alert thresholds and operational recovery drills.
  - 归属：D 部分已覆盖
  - 说明：部分已覆盖：告警规则、积压与死信阈值、以及本地双 provider 故障/恢复演练已由 ADR 0042 的运维监测完成（见 docs/operations/operational-monitor.md）。剩余的真实主机告警接线与恢复演练需要外部环境。
- 第 22 项（phase-gates 第 146 行）：Verify migrations, backup/restore, health/readiness, graceful shutdown, logs and monitoring.
  - 归属：D 部分已覆盖
  - 说明：部分已覆盖：健康/就绪检查、监控与日志已有实现与文档。剩余的备份恢复演练需要真实存储，仓库内不能完成。

## 维护

- `scripts/phase-gate-disposition.test.ts` 校验：phase-gates.md 中每条未勾选条目原文都出现在本文件中，且只出现一次；本文件不包含已经不存在的未勾选条目。
- 若 phase-gates.md 中某条被勾选或改写，须同时更新本文件，否则测试失败。
