# Documentation index

Status: active

Every document under `docs/` (except the ADRs, which are indexed in [docs/architecture/decisions/README.md](architecture/decisions/README.md)) carries a `Status:` header so a reader can tell current guidance from historical records.

Status values: `active` (current, follow it), `done` (completed work, kept as a record), `archived` (historical — do not treat as current).

## ADRs

Architecture decision records and their Accepted/Superseded status live in the [ADR index](architecture/decisions/README.md).

## 前端 UI（packages/web-ui）

前端设计规范位于 [packages/web-ui/docs/UI_DESIGN_SYSTEM.md](../packages/web-ui/docs/UI_DESIGN_SYSTEM.md)（Status: active），它是唯一有效的 UI 规范；颜色等 token 以 `packages/web-ui/src/styles/globals.css` 为准。早期前端落地说明 [IMPLEMENTATION_NOTES.md](../packages/web-ui/docs/IMPLEMENTATION_NOTES.md) 已归档（Status: archived），不作为现行事实。这些文件不在本目录下，因此不列入上方的索引。

## docs/architecture

- [API authentication contract](architecture/api-authentication.md) — Status: active
- [全量作品目录与回收站管理](architecture/authoring-catalogue.md) — Status: active
- [BFF 路由：一个 handler，一次安全决策](architecture/bff-routes.md) — Status: active
- [Conversation read order and upgrade boundary](architecture/conversation-read-order.md) — Status: active
- [第一方字体分发与性能守门](architecture/first-party-fonts.md) — Status: active
- [Legacy access-token compatibility and migration plan](architecture/legacy-token-compatibility.md) — Status: active
- [本机阅读清单、续读与文章内查找](architecture/local-reading-list.md) — Status: active
- [私信写入：账户绑定与未确认请求](architecture/messaging-intent-safety.md) — Status: active
- [Threat model: reports, moderation and appeals (accepted design, unshipped feature)](architecture/moderation-threat-model.md) — Status: active
- [通知账户归属与页面恢复隔离](architecture/notification-account-isolation.md) — Status: active
- [Notion background import: implementation plan](architecture/notion-background-import-plan.md) — Status: active
- [Read-only audit: historical Notion import provenance](architecture/notion-import-provenance-audit.md) — Status: active
- [Article conditional writes and Notion import version protection](architecture/notion-import-version-protection.md) — Status: active
- [Persistence Adapter Behavioral Contract](architecture/persistence-adapter-contract.md) — Status: active
- [Persistence domain slices](architecture/persistence-slices.md) — Status: active
- [Persistence-provider and online data-migration plan](architecture/postgres-migration-plan.md) — Status: active
- [Identity and featured-shelf snapshots in provider replay](architecture/provider-migration-identity-featured.md) — Status: active
- [Read-only single-provider media materialization audit](architecture/provider-migration-media-audit.md) — Status: active
- [Read-only media comparison (diagnostic only)](architecture/provider-migration-media-comparison.md) — Status: active
- [Media references in provider replay](architecture/provider-migration-media-references.md) — Status: active
- [公开标签发现与订阅（含全站订阅）](architecture/public-tags.md) — Status: active
- [REST write idempotency contract](architecture/rest-idempotency.md) — Status: active
- [开发前先查：公共模块索引](architecture/shared-modules.md) — Status: active
- [Web 上游期限、容量与下载边界](architecture/web-upstream-timeouts.md) — Status: active
- [文稿集合备份与离线核对](architecture/writing-collections.md) — Status: active
- [写作台：未保存保护与本机文稿工具](architecture/writing-workbench.md) — Status: active

## docs/api

- [Article view counts](api/article-view-counts.md) — Status: active
- [Authoring language editions](api/authoring-locales.md) — Status: active
- [客户端接口覆盖度检查](api/client-coverage.md) — Status: active
- [Reading further down a comment thread](api/comment-thread-pagination.md) — Status: active
- [Reading an old notification inbox](api/notification-inbox-pagination.md) — Status: active
- [Notion interchange: importing a database, exporting work back](api/notion-interchange.md) — Status: active
- [The published API contract](api/openapi.md) — Status: active
- [服务端能力缺口清单（面向文学发布平台 + Flutter 客户端）](api/platform-capability-backlog.md) — Status: active

## docs/operations

- [离线告警历史证据：只读审阅、比较、检查点与追踪](operations/alert-evidence.md) — Status: active
- [离线签名告警交接与独立收件箱](operations/alert-handoff.md) — Status: active
- [API observability](operations/api-observability.md) — Status: active
- [Host qualification: does the deployment survive the host?](operations/host-qualification.md) — Status: active
- [Account mail: off until you switch it on](operations/mail-setup.md) — Status: active
- [Neon deployment and operations](operations/neon-deployment.md) — Status: active
- [Notification worker — standalone operation contract](operations/notification-worker.md) — Status: active
- [Notion durable import jobs：默认关闭的操作切片](operations/notion-import-jobs.md) — Status: active
- [有限只读运维监测：规则、事件确认与恢复演练](operations/operational-monitor.md) — Status: active
- [One portable command: the whole stack on plain Node.js](operations/portable-stack.md) — Status: active
- [公开站点地图与爬虫资源](operations/public-crawl-resources.md) — Status: active
- [Scheduled maintenance — the one-shot cleanup run](operations/scheduled-maintenance.md) — Status: active
- [Web article authoring](operations/web-authoring.md) — Status: active
- [Web 共享刷新协调：迁移、观测与故障处理](operations/web-refresh-coordination.md) — Status: active
- [本机写作停顿与配对节奏审阅](operations/writing-cadence.md) — Status: active
- [本机三方文稿合并：使用与失败处理](operations/writing-merge.md) — Status: active
- [本机文稿重复段落审阅](operations/writing-overlap.md) — Status: active
- [本机双语与平行文稿对照审阅](operations/writing-parallel.md) — Status: active
- [写作台：可选本机恢复的使用与故障处理](operations/writing-recovery.md) — Status: active
- [本机术语一致性审阅](operations/writing-terms.md) — Status: active
- [本机文稿密码文件：使用、核验与故障边界](operations/writing-vault.md) — Status: active

## docs/roadmap

- [Hosting Qualification — Zero-Cost / No-Card Gate](roadmap/hosting-qualification.md) — Status: active
- [New Product Roadmap and Phase Gates](roadmap/phase-gates.md) — Status: active

## docs/archive

- [Frontend framework and hosting-portability migration](archive/frontend-portability-migration.md) — Status: done
- [Media relay adapter (Phase 5a)](archive/media-relay.md) — Status: done
- [Next step: fix the open issues, or start the React Router migration?](archive/next-step-decision.md) — Status: done
- [Public SSR route migration (Phase 3)](archive/public-ssr-migration.md) — Status: done
- [React Router 7 prototype — Phase 1 report](archive/react-router-prototype.md) — Status: done
- [REST transport layout (issue #58, step 2)](archive/rest-transport-split.md) — Status: done

## docs/audit

- [Roadmap evidence review](audit/2026-11-roadmap-evidence.md) — Status: archived
- [UI polish decisions: reading, writing and error pages](audit/2026-11-ui-polish-decisions.md) — Status: archived
- [#331 公钥-only 历史证据审阅：审阅与验收记录](audit/alert-evidence-review.md) — Status: archived
- [#331 离线签名告警交接：审阅与验收记录](audit/alert-handoff-review.md) — Status: archived
- [合法文章集合兼容性、读取所有权与测试发现审查](audit/article-collection-review.md) — Status: archived
- [后端核查报告（2026-11-02）](audit/backend-review-2026-11.md) — Status: archived
- [Feature Traceability — New Implementation](audit/feature-traceability.md) — Status: active
- [no-wave / BOT THK 代码库全面 Review](audit/full-review-2026-11-02.md) — Status: archived
- [#368：用不同匹配引擎修复依赖审计阻塞](audit/glob-engine-replacement.md) — Status: archived
- [身份刷新可靠性：本轮独立验收与代码审计](audit/identity-refresh-acceptance.md) — Status: archived
- [Legacy Backend Security and Reliability Findings](audit/legacy-backend-security-findings.md) — Status: archived
- [Legacy Frontend Audit Findings](audit/legacy-frontend-findings.md) — Status: archived
- [本地开发链历史记录](audit/local-development-history.md) — Status: archived
- [#329 / #330：双语通知与顶栏弹层验收](audit/locale-dialog-acceptance.md) — Status: archived
- [通知服务运维闭环：范围、行数与验收证据](audit/notification-operations-acceptance.md) — Status: archived
- [#331 默认关闭的 durable Notion job：审阅与本轮验证记录](audit/notion-job-review.md) — Status: archived
- [#331 有限只读告警切片：审阅与验收记录](audit/operational-monitor-review.md) — Status: archived
- [本机阅读清单、显式续读与文内查找：本轮验收](audit/reading-shelf-acceptance.md) — Status: archived
- [REST–GraphQL Contract Parity Audit](audit/rest-graphql-parity.md) — Status: archived
- [REST write idempotency inventory](audit/rest-write-idempotency-inventory.md) — Status: archived
- [Web/BFF 资源边界与共享模块收敛审查](audit/web-upstream-review.md) — Status: archived
- [本轮审阅：本机写作停顿与配对节奏审阅](audit/writing-cadence-review.md) — Status: archived
- [文稿集合备份与离线核对：独立功能行与边界审阅](audit/writing-collections-review.md) — Status: archived
- [本机三方文稿合并：范围、回归与本轮独立有效行验收](audit/writing-merge-review.md) — Status: archived
- [本轮审阅：本机文稿重复段落审阅](audit/writing-overlap-review.md) — Status: archived
- [本轮审阅：本机双语与平行文稿对照审阅 (writing-parallel)](audit/writing-parallel-review.md) — Status: archived
- [可选本机文稿恢复：本轮范围、回归与独立有效行验收](audit/writing-recovery-review.md) — Status: archived
- [本轮审阅：本机术语一致性审阅](audit/writing-terms-review.md) — Status: archived
- [本轮审阅：本机密码文件、Worker 和无损字节复核](audit/writing-vault-review.md) — Status: archived
- [写作台文稿工具：范围、安全与独立行数验收](audit/writing-workbench-acceptance.md) — Status: archived

## docs/testing

- [Acceptance Scenarios: Messaging and Notifications](testing/acceptance/messaging-and-notifications.md) — Status: active
- [Acceptance Scenarios: Security and Authorization](testing/acceptance/security-and-authorization.md) — Status: active
- [Browser-level tests (Playwright)](testing/end-to-end.md) — Status: active
- [Framework Portability Spike — Execution Checklist](testing/framework-spike.md) — Status: archived
- [Testing Strategy: Behavior-First, Risk-Based](testing/strategy.md) — Status: active

## docs/deployment

- [Capacity: what one instance actually does](deployment/capacity.md) — Status: active
- [Persistence-provider deployment guidance](deployment/persistence-provider-guidance.md) — Status: active
- [Copying a database to another engine (off-line)](deployment/provider-transfer-runbook.md) — Status: active

## docs/development

- [Local development and local verification](development/local-development.md) — Status: active
- [名称与关系：BOT THK、no-wave、无浪潮](development/names.md) — Status: active

## docs/requirements

- [BOT THK Product Behavior Baseline](requirements/behavior-baseline.md) — Status: active

## docs/agentic-coding

- [Agentic Coding Workflow](agentic-coding/workflow.md) — Status: active
