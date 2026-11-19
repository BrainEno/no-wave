# ADR 0045: 文稿恢复默认关闭，缓存有界隔离且只允许手动复制编辑字段

- Status: Accepted
- Date: 2026-11-12
- Approval: owner 明确选择 `approve-writing-recovery-full`，接受未加密、同源脚本及共用设备风险；不是把泛化的“下一轮”当作持久化批准。
- Scope: 浏览器本机文稿缓存、人工恢复、只读来源核对和会话边界；不增加自动发布、自动重放、跨设备同步或生产部署。

## 背景与风险

[既有文稿工具](../writing-workbench.md)只手动下载/读取文件，未保存输入默认只在页面。
刷新、崩溃或操作失误会丢失文字，但自动持久化私密草稿也会扩大隐私和账号隔离风险。
本轮在提出容量、同源风险、退出清除和失败验证边界之后才获得明确批准。
这是**高风险**变更：私密内容持久化、跨标签事务、陈旧身份证明、保存结果不明及恢复竞态
均采用回归测试先行，不以客户端 ID 或 IndexedDB 内容建立服务端身份。

## 决策

1. **默认关闭，设备上明确启用。** 勾选未加密风险说明并点击启用后，当前账号的新标签
   才能继承本设备的 opt-in。关闭时不存文稿；允许创建空库/控制元数据用于隔离检查。
   缓存只提取既有五个可编辑字段，另外记录隔离所需的账号、来源语言/作品/修订及本机
   并发元数据；不附加密码、Cookie、token、幂等键、请求字节或待重试指令。
   不扫描/脱敏作者自己输入的正文；其中仍可能含敏感内容。
2. **一个有界活跃命名空间。** IndexedDB `no-wave-writing-recovery-v1` v1 的 `control`
   和 `drafts` 在同一事务中读取/校验/修改。最多 20 份、合计 16 MiB UTF-8 序列化
   记录；每条不超过 2 MiB + 4096 字节且仍受既有备份内容限制。达到预算拒绝新写入，
   不静默淘汰、不自动按时间过期。每个编辑器独立 writer/分支，不能只按作品 ID 覆盖。
3. **持久化不是授权。** 每次读、写、恢复、下载、删除或来源核对都重验预期账号；
   actor 不从缓存推断。控制 epoch、全局递增 serial、writer 和 expected revision
   共同防止旧标签、延迟证明、ABA 删除/重建、陈旧覆盖/删除或越账号读取。
   namespace 改变在事务内清除旧稿；无效数据失败关闭，人工整体清除不依赖解析旧稿。
   唯一的被动捷径是此前已核实关闭且 control 未变时只读取 metadata，返回 off、
   actor=null、无 lease/无文稿；不是缓存身份证明。显式刷新/启用、control 变化或任何
   已启用的命名空间仍需 live actor，关闭状态的 witness 不得授权启用或读取稿件。
4. **有限、可见的失败。** 打开/事务默认各有 4 秒上限，成功只能在 transaction complete
   后报告，不能把 IDBRequest success 当作提交。quota/abort/blocked/denial/timeout/
   时钟回退/serial 耗尽都保留错误，不声称缓存成功；已有稿不被半次写入替换。
   输入以约 600 ms debounce 缓存，单次 drain 最多 8 轮；不在 unload 启动不可靠写入。
5. **恢复只复制字段。** 刷新后编辑区仍为空/服务器原稿，不自动把缓存灌入 Lexical。
   作者选择缓存、预览、勾选字段并确认后，才在同步的最终检查区应用；完整输入/目标
   基线/缓存 witness 或当前账号变动使旧预览失效。异作品/修订需额外确认，远程图片
   需单独同意；列表、预览和差异只显示转义文本，不请求图片或跟随链接。
   恢复不切换服务器身份、slug、revision 或发布状态；正文保留既有一次撤销语义。
6. **未知保存不被恢复伪装成成功。** opt-in 后，文章请求 dispatch 前必须完成 durable
   uncertainty checkpoint；失败则不发送该文章请求。响应只结算本编辑器精确 writer/
   revision，后来编辑不被响应清空。恢复 outcomeUnknown 文稿后拦截保存/发布，直到
   作者核对服务器并明确确认；即便内容相同也不是原请求回执。原有 pending-create
   精确请求与 retry key 始终只在原页面，不持久化、不在刷新后自动确认/重放。
7. **来源核对是手动的只读观察。** 复用 catalogue 的精确 actor/id/locale/revision
   校验、shared HTTP 的绝对 deadline/限流/响应字节边界、既有块适配器和有界 diff。
   显式 GET 默认 8 秒、2 MiB，拒绝 redirect、非 JSON、坏 UTF-8 和超额流；429 只保留
   有限人工等待期，不自动重试。返回后再次核对账号和完整缓存 witness，延迟/已变更
   结果不展示。BigInt 区分同修订、前进、回退或未知；不可读取/未关联不猜其他语言。
   只显示时间、状态、修订和字段/正文差异，不合并、不写库、不采用服务器基线或解除拦截。
8. **退出两侧 fence。** 登录/注册、退出、当前设备撤销和重置密码的账号变更请求前后
   均同步广播失效并尝试原子 purge；失败响应也执行第二次 purge，防止等待请求期间
   新打开并启用的标签留下缓存。任一清除失败均保留警告，不阻止退出也不悄悄跳转丢掉
   警告。跨标签通知只有 `{version, source}` 元数据；BroadcastChannel/storage event
   只是 best effort，持久 epoch 才是最终写入 fence。缺少安全随机 ID 不得阻止本页
   失效和清除尝试；若无法生成新的磁盘 fence，报告未能清除，不伪造随机来源。
9. **隐藏与失效不同于清空当前输入。** pagehide/hidden/bfcache 同步隐藏缓存 DOM，
   focus/online/返回页面重验身份。退出或其他标签关闭后，旧实例不可重新启用或写入；
   作者仍可按既有未保存保护下载当前页面内存中的输入。不会声称擦除全部标签的编辑区、
   浏览器历史、已下载文件或物理存储残留。

## 复用与最小变更边界

检索并复用了 shared-module index、`writing-session`、`writing-backup`、
`writing-compare`、`writing-document`、`lexical-article-state`、
`CollectionDownloadLease`、`CatalogueDocumentReader`、notification actor transport
和 `@bot-thk/web-http` 的 deadline/limited stream/retry-after 工具。
新 model/store/controller/boundary/lifecycle/source 只负责原来不存在的本机持久化与恢复
协调；不复制 REST 授权、HTTP 重试、富文本解析或下载 Blob 策略。
React/Lexical、账号组件只做编辑快照、请求 dispatch 和生命周期边界的接线。
没有 API/BFF 新路由、业务数据库 schema、权限、生产限流或自动任务改动。

## 不选的方案与剩余风险

- localStorage 存正文：同步、无跨记录原子事务，不满足控制 fence 与稿件的一致性。
- 自动 last-write-wins、静默淘汰或恢复即保存：会覆盖另一个标签、新服务器修订或旧稿。
- 保存请求/幂等键到磁盘：把恢复缓存变成未经批准的 durable request replay queue。
- 对称加密但密钥也保存在同源浏览器：不能兑现对同源脚本/共用设备的隔离承诺。
- Service Worker/background sync、自动重试或无限 drain：扩大生命周期与服务端副作用。

IndexedDB 事务、`durability: strict` 和测试不证明设备 fsync、断电耐久或浏览器不会回收
数据；quota 注入也不等于填满真实磁盘。缓存未加密，XSS/恶意扩展、同源脚本、共用
浏览器配置和设备备份仍可暴露稿件；下载的 JSON 也未加密。不能联网确认身份时不展示
缓存，但内存中已有编辑仍按原保护保留；离线恢复缓存不是本次授权范围。

仅新增精确固定的开发依赖 `fake-indexeddb` 6.2.8（Apache-2.0、Node >=18）支持真实
事务 API 的单元回归；不进入浏览器 bundle，不新增运行时库。
支持隐私/禁用存储环境的失败提示，不承诺所有浏览器配额与磁盘实现。
[#331](https://github.com/BrainEno/no-wave/issues/331) 的真实主机、跨主机、通知到人、密钥、
备份/回滚及其余发布门禁保持独立开放；本批准不授权生产部署或任何破坏性服务器操作。
使用/故障恢复见[本机恢复说明](../../operations/writing-recovery.md)，
当前轮验证与独立行数见[审阅记录](../../audit/writing-recovery-review.md)。
