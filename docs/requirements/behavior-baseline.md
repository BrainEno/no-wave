# no-wave Product Behavior Baseline

Status: active

Baseline state: initial capability baseline. Verify each item against the previous product before treating the inventory as exhaustive.

The previous project provides the reference for user-visible capabilities and known behaviors. The new implementation should cover those capabilities but does not have to retain unsafe code, old schemas, implementation patterns or accidental bugs. When an improvement would change product behavior, authorization policy, destructive lifecycle rules or compatibility expectations, first explain the options and risks and ask for approval.

## Public content

- Visitors can browse published articles and article details without signing in.
- Visitors can browse public author profiles and published content by an author.
- Article/author pages provide meaningful titles, descriptions, canonical/share metadata and crawlable HTML.
- Search, categories, tags, related articles and public comments remain available where supported.
- Draft and unpublished content is not exposed in public queries.
- Article bodies support structured blocks rather than assuming every article is a single plain-text field.
- The article editor and comment editor use Lexical as the shared editing framework, with different allowed-node and feature configurations. The application-owned, versioned document contract—not raw HTML or an unvalidated editor payload—is authoritative; see [ADR 0007](../architecture/decisions/0007-lexical-rich-text-editors.md).

## Categories and user-generated hashtags

- Categories and tags are separate taxonomy kinds with localized display labels.
- Hashtags are not a fixed enum or static list. Authenticated users can create hashtags dynamically, including Traditional Chinese and other supported Unicode letters/numbers.
- Hashtag creation normalizes equivalent forms such as an optional leading `#`, full-width forms and case variants; duplicate creation should reuse one global tag rather than create per-user duplicates.
- Authors can reuse community hashtags when creating or updating their own articles.
- Public hashtag pages list only published articles with the requested locale; drafts must not leak through taxonomy queries.
- The current tag creator/deletion policy and category creation/moderation policy require an explicit product decision before changing the existing behavior. Deleting a shared tag may affect several articles, so destructive lifecycle rules must not be broadened without approval.

## Accounts and profiles

- Users can register, sign in/out, refresh sessions and recover/reset passwords, subject to the verified product inventory. The selected self-hosted API implements the first four; recovery and email verification are now implemented server-side but are **not yet deliverable** — outbound mail goes through a port whose only implementation writes a log line, because provider code waits on the hosting gate ([ADR 0008](../architecture/decisions/0008-self-hosted-api-identity.md), [ADR 0014](../architecture/decisions/0014-password-recovery-and-email-verification.md)). Verification gates nothing: an unverified address still signs in and publishes.
- Users can view/edit permitted profile fields; public profile data is separate from private account data.
- Client-supplied user IDs cannot impersonate another user.

## Social features

- Users can follow/unfollow other users; state is consistent without duplicate relationships.
- Users can like/unlike articles and add/reply to comments where permitted.
- Mutations enforce authentication and resource-level ownership on the server.
- Notifications for follow, like, comment and reply are emitted according to approved product behavior; duplicate retries do not produce duplicate logical events.

## Messaging

- Authenticated participants can create/access conversations according to the approved product rules.
- Only participants can read history, send messages, change read state or manage participants where authorized.
- Sender identity comes from authenticated server context rather than a client-supplied sender ID.
- Messages persist while recipients are offline; reconnection retrieves authoritative history and unread state.
- Retries and concurrent actions do not corrupt state or create duplicate logical messages.

## Notifications

- Notifications have a recipient, stable identity, creation time and read state.
- Persisted notification history is the source of truth; real-time/push delivery does not replace persistence.
- Pending message notifications select current active members at delivery time, excluding the original sender; see [ADR 0009](../architecture/decisions/0009-message-notification-recipient-timing.md).
- Push delivery is best effort and must not imply the user has seen a notification.
- Push permissions are opt-in and revocable.

## Writing files and local three-way review

- 单篇 JSON 备份/字段恢复、两稿比较、集合工具及默认关闭的可选恢复缓存保持可用。
- 已批准的 `/write/merge` 只在内存处理用户明确选择的共同基线/当前稿/另一稿，精确比较
  元数据、格式与正文，显示单侧建议；重复段落/顺序歧义不猜对应关系，冲突须人工逐项选择。
- Given 来源或人工取舍已变，When 旧读取/分析/计划/输出准备完成，Then 不得覆盖新状态、
  复活旧 DOM 或继续下载。筛选分页不能丢弃隐藏的选择。
- Given 下载决策计划，Then 只含闭集引用和来源摘要，不含正文；重新使用先核对原三份文件，
  预览并另行确认完整替换，不自动应用。
- Given 所有冲突已取舍，When 准备新备份，Then 独立校验三份来源无遗漏/乱序，并将
  序列化输出逐项核对人工选择和完整既有备份限制；超限整份失败，不截断或部分成功。
- 最终只有手动新 JSON 下载；不改原文件、编辑区、缓存或服务器，不建立身份、媒体权限、
  保存回执或自动发布/重放。选错基线/人工取舍和未加密/共用设备风险必须说明。
  详细边界与验收见 [ADR 0046](../architecture/decisions/0046-local-three-way-writing-merge.md)、
  [操作说明](../operations/writing-merge.md)与[本轮审阅记录](../audit/writing-merge-review.md)。

## Read-only local paragraph overlap review

- `/write/overlap` 仅处理用户明确选择的一份既有单篇备份/集合；默认字面与跨篇，
  显式可选 NFKC/小写/空白折叠及同篇范围；完整文字、富文本节点种类与近似分数分开显示。
- Given 已校验来源，When 分组/近似分析，Then 保留每处原文/路径，不物化平方级位置对，
  不把相同文字或 100% 片段集合相似当作相同节点、语义、作者或自动去重/合并依据。
- Given 来源、规范化、索引、访问、候选、评分或列表预算，When 达限，Then 来源超限整轮拒绝，
  近似缺口明确报告，未完成比较不输出假分数；零结果不作全文无重复证明。
- Given 换文件/条件、无效数字中间输入、取消、重跑或离页，When 旧读取/摘要/进度/按需解释完成，
  Then 不复活候选、正文 DOM、片段、临时标记、报告或下载确认；筛选/分页不丢隐藏标记。
- Given 文稿对概览，When 聚合或限定视图，Then 组合计数与原分析一致，不物化所有位置对，
  列表及左右选择器均限于当前文稿对，近似组的两个有效方向仍可选；全局标记和报告不变。
- Given 片段集合 100% 但频率/顺序不同，When 显式解释所选两处，Then 每个片段全部位置、
  次数差异、共享覆盖和唯一位置链仅作诊断，规范化坐标不冒充原文坐标；片段和筛选词不进入报告。
- 报告只有显式准备/核对/手动下载，包含全局已列 finding、未核对数、覆盖限制与本机坐标/摘要，
  不含正文/标题/摘要文字/原文件名/URL/节点，且无导入或应用入口。
- 不上传、持久化、请求来源媒体、修改原稿/编辑区/恢复缓存/服务器、自动发布或重放。
  详细边界见 [ADR 0048](../architecture/decisions/0048-read-only-local-writing-overlap.md)、
  [使用说明](../operations/writing-overlap.md)与[本轮证据](../audit/writing-overlap-review.md)。

## Read-only local terminology review

- `/write/terms` 只使用明确选择的完整本机备份/集合及严格手动词表；默认字面，可选仅 ASCII 大小写折叠。
- Given 同形、后缀、包含和重叠词条，When 分析，Then 保留每个主张与原文 UTF-16/代码点坐标；偏好不作为正确性或替换指令。
- Given 来源/词表超限，When 校验，Then 整轮拒绝；Given 计算预算，Then 同一结束位置全部提交或不提交，精确未覆盖前沿可见。
- Given 词组/文稿分布与拼写组合，When 查看，Then 区分主张/精确跨度/重叠团，折叠同形不冒充多种拼写，未覆盖不冒充完整缺席。
- Given 手动标记、视图筛选或文稿对照，When 准备报告，Then 始终保留全局口径；无正文/词条明文/标题/摘要/文件名/URL/节点。
- Given 输入或条件变化、无效词表中间稿、取消、重跑或隐私清理，When 旧读取/摘要/进度/计算完成，Then 旧定位、标记与下载不能复活。
- 不写原件、编辑区、服务器或浏览器存储，不自动替换、上传、同步、保存、发布或重放；报告只显式准备/核对/手动下载。
  详细边界见 [ADR 0049](../architecture/decisions/0049-read-only-local-writing-terms.md)、[使用说明](../operations/writing-terms.md)与[审阅记录](../audit/writing-terms-review.md)。

## Read-only local writing cadence review

- `/write/cadence` 只使用用户明确选入的完整单篇备份或集合 JSON，支持设定扫描范围、引号策略与长短句长度阈值。
- Given 标点符号与停顿结构，When 流式扫描正文，Then 按终结符切分停顿片段，记录句内停顿，分类统计过短、正常与过长片段；遇到结构断点或跨单元边界绝不跨结构拼接。
- Given 括号与引号等成对符号，When 对称与嵌套匹配，Then 维护显式配对栈，强制执行 128 层最大深度门禁；超深截断并生成独立 finding，不发生栈溢出。
- Given 配对跨度与停顿边界，When 差分交叉扫描，Then 采用反向区间 join，严格核算穿透边界与深度，并验证配对跨边界总数恒等于全部缝隙深度之和；跨 run 跨度立即拒绝。
- Given 零宽空格、连字符或双向控制符，When 检测，Then 按代码点归类统计并提供定位样本，不静默擦除或自动替换。
- Given 审阅视图与人工标记，When 筛选或分页，Then 保持有界惰性渲染；手动标记“有意使用 / 后续检查”仅保留在内存，不影响全局报告口径。
- Given 策略调整、无效数字中间输入、重新分析、取消或离页，When 异步事件触发，Then 双读取栅栏撤销旧数据，同步清理 DOM 与引用，不复活旧数据或下载。
- 不修改原稿、编辑区或服务器数据，不提供自动润色或格式化，不生成可导入应用的反向修改计划；报告仅脱敏导出元数据与统计特征。
  详细边界见 [ADR 0050](../architecture/decisions/0050-read-only-local-writing-cadence.md)、[使用说明](../operations/writing-cadence.md)与[审阅记录](../audit/writing-cadence-review.md)。

## Cross-cutting

- Private data is never exposed through public endpoints or shared caches.
- Errors remain visible and actionable; failed writes do not appear successful.
- Web UI remains usable on mobile and supports Traditional Chinese as the design baseline and English without broken layouts.
- PWA/offline behavior is specified separately from guaranteed background delivery.
- Future mobile/desktop clients share API contracts and domain rules but can use platform-specific UI.

## Traceability

Link each behavior to legacy evidence, acceptance tests, new implementation modules and any release/deployment requirements. Mark uncertainty explicitly instead of guessing.
