# ADR 0041: Notion 导入任务默认关闭，崩溃后不自动重放写入

- Status: Proposed — 已实现默认关闭的审阅切片；不代表生产启用或托管验收获准
- Date: 2026-11-12

## 范围

这是 #331 的 durable import-job 子集，不关闭整个 issue，也不替代其真实托管、
回滚演练、告警和 Phase 6 责任人确认。沿用 ADR 0036 / ADR 0037：作者自己取得
bundle，Notion 凭据不进入服务器，现有同步导入与 UI 不迁移、不退役。

## 行为约束

1. **提交不是执行。** 默认关闭的认证 REST 接受原始 bundle、尚有效的既有签名
   dry-run plan 和请求幂等键。校验账号、bundle hash、数据库 generation、原预览
   期限后加密入队。API 不启动队列执行定时器。只有独立、有限次的 operator command
   执行既有 importer，不增加长期运行的服务角色。
2. **没有 crash mutation retry。** 一次原子 claim 生成一个随机租约；过期 running
   转为 `interrupted`，而不是重新排队。每作品仍是一个既有文章／标签／provenance
   事务；事务开始、结束都检查同一 job 的 owner、token、状态、数据库时间及执行
   deadline。PostgreSQL 先锁 job，再锁页面和文章，取得锁后才读取时钟。
3. **取消不回滚已完成作品。** DELETE 等待已经持锁的作品事务结束，删除输入并
   阻止下一次作品写入。准备媒体期间的取消和失效租约也不能越过提交 fence。
   drain 的取消／期限停止接纳新工作，等待物理操作完成；不是强杀保证。期限在
   数据库事务内再次检查，避免一个晚到的提交仅凭旧的 HTTP/preflight 检查写入。
4. **进度只是已确认结果。** 完整作品提交与随后进度确认之间仍有不确定窗口。
   `completed` 不能证明其后没有已提交作品。恢复方式是检查自己的作品和媒体，
   重新预览后明确提交新任务；不保存／恢复 image/page mutation checkpoint。
5. **输入是敏感数据。** 分别使用既有 AES-256-GCM envelope 封装 bundle 和 plan，
   AAD 绑定 owner、job、输入期限、用途和 key id。密钥在数据库外配置，最多三个
   显式命名的 key；新入队只使用 active key。轮换、移除旧 key 和备份均为 owner
   的显式运维操作。没有自动重加密、自动 key 生成或 Notion URL 刷新。
6. **状态不是原始导入报告。** 返回 ordinal、action、locale、本账号文章 UUID、
   已知 issue code 和计数；不含源标题／页面 ID／URL／正文／原诊断／plan／租约。
   保留期限是原输入到期后 24 小时。到期立即失去解密／写入资格；物理行清理由
   下一次有界数据库交互或独立 sweep 触发，不承诺无人运行命令时的准点擦除。
7. **容量有固定上限。** 每账号／全局活跃数 2／32，保留行 20／1000，密文总字节
   24 MiB／64 MiB，单任务密文 12 MiB，安全报告 128 KiB。bundle 8 MiB、200 页、
   八次图片复制和既有生产限流不提高。SQLite 使用 `BEGIN IMMEDIATE`，PostgreSQL
   使用窄 admission advisory lock 与逐 job row locks / `SKIP LOCKED`。
8. **恢复丢失的响应不需要重放。** 原 owner 可用 GET collection 的原幂等键 header
   精确查询仍保留的任务（零或一条），即使预览过期或新提交已关闭。POST 仍先验证
   有效签名预览；不能把查询能力误当成过期写入授权。
9. **Cookie 代理不扩大信任。** 新增共享 BFF handler 和薄 React Router 资源路由，
   不新增 UI。写入同源校验、Cookie-only bearer、同 token actor 条件、一次协调刷新、
   轮换后错误仍保留 cookies、no-store 与 Retry-After 沿用既有边界。状态查询使用
   强 ETag 与最多五秒的请求内等待；默认最多 16 组、每组四个订阅者、两个物理查询，
   断开的订阅者不制造新数据库容量。这不是 SSE 或队列执行器。
10. **迁移不是 job 搬运。** operational ciphertext／租约／终态记录不属于 domain
    provider transfer。源或目标有 queued/running 时，dry-run 和真实转移都拒绝。
    必须先停写、完成或取消任务并 sweep；跨数据库的停写条件不能由一次前置检查
    代替。完整数据库备份仍可能含密文、WAL 和历史副本，逻辑删除不等于安全擦除。

## 验证与发布门禁

- 两个 provider 跑同一契约：认证隔离、原子竞争 claim、幂等、配额、密文删除、
  过期／取消／事务内失效回滚、重启、只读 key/generation 检查与原键查询。
- 保留现有同步导入、媒体 owner、签名计划、revision 和文章集合最大合法负载验证。
- 实际执行全量、本轮 head 的真实 PostgreSQL、浏览器、容器、依赖审计和 CI。
- 本文是审阅中的默认关闭边界，不授权 merge、部署、生产 key 操作或自动调度。
  启用前须按[操作规程](../../operations/notion-import-jobs.md)明确责任和证据。
