# ADR 0044: 告警历史证据使用独立公钥、只读集合审阅和不授予权限的导航

- Status: Accepted
- Date: 2026-11-12
- Approval: 本轮 owner 明确选择“批准完整只读范围”；不追认其他运维动作或改变 ADR 0041–0043 的状态。
- Scope: #331 的仓库内离线证据审阅，不是生产告警或人员通知放行。

## 背景与审批

[ADR 0043](0043-offline-signed-alert-handoff.md) 的 v1 batch/receipt 可以在只有公钥
的工作站独立核验，但单份签名不能说明多批次链是否有缺口、两次取证是否删除了旧证据，
也不能发现仅靠本份清单无法知道的历史遗漏。旧 inbox 的签名分页需要接收方私钥，
不能直接用于不持私钥的审阅工作站，更不能把导航位置当成 settle/consume 授权。

本轮曾先写草稿再发现 product-decision gate 未补齐，已停止提交/PR/merge，向 owner
说明风险并提供三种选择：完整 review/compare/check/trace、仅 review/compare、暂停新
命令。owner 明确批准完整只读范围后继续验证。本批准不等于修改既有 v1 协议或运行
生产命令；泛化的“继续下一轮”不应代替以后仍需单独提出的产品决策。

## 决策

1. 增加显式、有限的 `ops:evidence`，没有默认执行模式、HTTP 服务、目录发现、
   网络请求、环境凭据回退或业务 store。所有模式只读显式本地文件，不加 writer 锁，
   不确认 monitor、不 settle、不消费 inbox、不修复、重投或生成回执。
2. 公钥 trust 与证据 manifest 分开由操作者指定。trust 只接收既有 v1 verify
   profile，1–16 个唯一来源及公钥，接收方身份/公钥必须一致；不接受任何私钥字段。
   复用原 Ed25519 域分离、closed schema、事件/签名解析，不让产物自己决定信任根。
3. manifest 只指定本目录下的有界相对 JSON 文件、batch/receipt 类型和原始字节
   SHA-256。复用自有私有 POSIX regular-file 边界，拒绝 symlink、hardlink、FIFO、
   特殊文件、路径越界、控制文件别名和超额输入；初读与复读不一致时失败关闭。
   多文件复读只提供保守的非原子证据，不声称防同 UID 恶意写入或跨文件最终性。
4. `review` 验证全部输入后审阅来源链、fork/前驱/revision/时间、跨批次 episode、
   回执匹配/歧义及同一 receiver 的全局顺序。缺少提供的证据记 gap，相互矛盾记
   conflict，配置变化/旧证据记 warning；缺口不被补成接收、消费或恢复成功。
5. `compare` 独立接纳两侧，并审阅其并集。删除旧 batch/receipt、回退或替换 tip
   不算进展；新增一条看似干净的链不能抹掉旧 fork。集合 extension 也不代表服务进展。
6. `check` 另外要求独立的 operator requirements 文件，绑定已核对的 trust 指纹，
   指定精确已知 batch、可选 receipt 及 point/prefix。prefix 沿签名前驱有界遍历，
   不按任意大 sequence 展开循环；同序号 fork 不能被精确 checkpoint 选择掉。
   要求文件和其 hash 不自认证，不能由候选 manifest 自己选择或自动产生验收条件。
7. `trace` 对全部事实验签和全局审阅后，才分页选择事件或完整 findings；支持来源、
   精确 batch/event ID、序号范围，以及各视图有意义的独立过滤。任何窄过滤、空结果
   或自行改写 cursor 都不能降低全局 attention 退出码。上下文只描述已提供的相邻
   同规则事实、签名链接和回执声明，不宣称完整历史或真实世界事件邻接。
8. trace cursor 是严格解析的 **unsigned navigation data**，绑定规范化证据集合、
   查询（含 limit/年龄预算）和有序结果行。数据/选择/结果变化后失效；不是密码学授权，
   没有消费、确认或隐藏全局冲突的能力。既有 inbox-read 签名 cursor 与其写入授权边界
   不变。类型/字符/范围/closed-field 校验与输出上限不因分页放宽。

## 不选择的方案及风险

- 仅核验每份签名：不能定位跨批次或跨来源矛盾，不能抵抗证据集删除造成的假进展。
- 让 manifest 提供自己的 key 或 expected checkpoint：把攻击者输入变成自己的证明。
- 为公钥审阅复制接收方私钥签 cursor：扩大密钥暴露面，且导航本来无需权限。
- 持久化“最新健康”缓存、自动修链/ack：历史签名不是当前观测，也没有自动副作用授权。
- 无界扫描归档或无限输出所有发现：输入和输出均须有限；完整发现用 trace 分页查看。

## 兼容性与剩余门禁

不改变 handoff/monitor 的 v1 产物、日志、key pin、签名 domain 或现有命令行为。
没有 REST/BFF/UI、数据库 schema、依赖、锁文件或 CI 阈值变化。新规范化 hash 仅是
标识符；与 manifest 原始字节 digest、操作者对 trust 的独立信任不可混同。

报告固定区分 `signed_history_only`、`provided_artifacts_only`、`tailFinality=not_proven`。
没有发现也不能证明未见尾部不存在、当前服务健康、通知到人、消费完成或物理持久性。
真实主机、跨主机传输、外部通知、watchdog、时钟、密钥保管/轮换、备份/回滚和 #331
总门禁保持开放。容量、命令、失败恢复见[操作规程](../../operations/alert-evidence.md)，
本轮实际验证和未跑门禁见[审阅记录](../../audit/alert-evidence-review.md)。
