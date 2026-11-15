# ADR 0040: 通知投递使用独立进程角色，探针与资源关停必须有界

- Status: Accepted
- Date: 2026-11-12
- Scope: #315、#320、#328；本地开发监督、API/worker 生命周期、容器运行契约

## 背景

消息事务已经可靠写入 outbox，但原来的 `pnpm dev` 只启动 API/Web，通知会持续排队。
同一个 API 镜像也缺少明确的独立 worker 角色。数据库连接成功不能证明通知有人消费；
反过来，数据库或通知积压导致就绪失败，也不能成为重启所有存活实例的依据。
原 API 的原始 URL 比较不接受带 query 的探针，等待 `server.close()` 时也没有绝对期限。

## 决定

1. 默认 `pnpm dev` 监督 API、notification worker、Web 三个子进程。
   `--api-only` 包含 API 与 worker，`--web-only` 不擅自启动外部 API 的 worker。
   API/worker 使用相同 cwd 和持久化环境，SQLite 必须是文件，不能使用进程私有的 `:memory:`。
   先同时启动 API/worker，再等待就绪，避免“积压导致 API 不就绪，worker 却尚未启动”的循环。
2. 保留 Node watch 热重载。任一子进程意外退出（包括未请求的 exit 0）、watch shell
   背后的应用失败、启动失败，均停止其余进程并返回非零。启动完成后持续检查就绪；
   暂时失去就绪会明确报告，默认允许 15 秒恢复，超过 `DEV_RECOVERY_TIMEOUT_MS` 则停止整套服务。
   API/worker 探针验证角色 JSON，而非把任意 HTTP 200 当作正确服务；响应体最多 8 KiB，
   请求及读取响应体都受超时/取消约束。强制停止覆盖 POSIX 进程组，Windows 使用 `taskkill /T`。
3. 一个 API 镜像运行一个长驻角色：`SERVICE_ROLE=api`（默认）或 `notification-worker`。
   `service.ts` 只动态加载选中的角色，worker 不要求 API JWT 或媒体配置。
   保留原 server/worker 入口以及一次性 drain。包命令的环境优先级为
   shell > `.env.local` > `.env`；开发监督器把根 `.env.local` 一次加载后传给三个进程。
4. API/worker 的 `GET`、`HEAD /health` 与 `/ready` 按 pathname 匹配，接受 query，响应 `no-store`。
   API 就绪同时要求 JWT 配置有效、持久化健康返回 `true`、积压采样可用，且最老 pending 年龄
   不超过 `API_OUTBOX_MAX_PENDING_AGE_MS`（默认 120 秒）。dead letter 单独报告，不当作 pending。
   API 复用现有 `outboxBacklog()`，每个依赖最多一项未完成读取，默认等待 500 ms、缓存 1 秒；
   失败保留最后成功的计数供监控，但不以旧值或超时后的迟到结果授予就绪。
   超时查询继续占有单飞槽位，完成后必须由新一轮及时查询恢复；停止立即释放等待中的探针，
   取消尚未进入驱动的微任务。计时使用单调时钟，时间戳使用墙钟。
5. worker 健康监听器与可选 metrics 监听器分开。健康监听器不因探针访问数据库；
   健康监听器在取得数据库之前启动，初始化被锁阻塞时仍报告存活/starting；
   只有完成首个持久批次才就绪。连续批次级失败、超过 lease/poll 预算的活跃批次、
   超过三倍 poll（至少 1 秒）未完成新批次的空闲进程、停止状态均返回 503，存活探针仍可返回 200。
   毒事件已完成 fenced retry/dead-letter settlement 不等同于数据库批次级故障。
   探针只含闭合集合的状态、时间及计数，不含消息、用户、token、DSN 或错误详情。
   可选积压指标使用独立的有界、单飞采样器：超时/无效/迟到结果不覆盖最后可信计数，
   不等待采样再投递，不为每次 scrape 启动查询。新鲜度与单调年龄单独报告；
   保留旧 `api_outbox_*` 样本语义，不把原有 gauges 重计为新增实现。
   SQLite 非空批次之间让出事件循环，避免持续 backlog 饿死健康检查、定时器和 SIGTERM。
6. API 显式设置 headers/request/keep-alive 为 15/60/5 秒，并设置不超过 1 秒的
   receive-timeout sweep，避免只改属性却仍等待 Node 默认 30 秒扫描。
   API/worker 的停止使用一个绝对预算（默认 8 秒），其中保留 2 秒关闭持久化等资源。
   停止后不再接收新请求或 claim 新事件；已经取得的单个 lease 仍尝试交付并 fenced settlement。
   到 drain 截止点强制关闭挂起 HTTP 连接，资源仅关闭一次，明确输出 forced/cleanup/exit 报告。
   worker 的未完成批次、未取得的持久化所有权、清理失败/超时均以非零退出，不谎称优雅完成。
   API 仅淘汰超时客户端且持久资源关闭成功时允许 exit 0，但必须报告 `forced=true`。
   API 的 signal handler 在打开数据库之前安装，不能在启动中收到信号后复活监听器。
   两个独立角色的未捕获异常/未处理 rejection 均为终止性故障：只记录安全类名与闭合来源，
   不输出 Node 默认的消息/stack dump，复用一次有界关停，始终非零退出；兜底计时不因二次异常重置。
   已启动的 API/worker 健康或显式 metrics 监听器异常关闭，也不能留下持久化进程静默存活。
   监听器 close 报错不得报告关停成功，必须尝试强制关闭且仍执行资源清理。
   `SERVICE_STARTUP_TIMEOUT_MS` 默认 30 秒（100..120000 ms），避免永久停在 starting：
   API 在完成 provider/health/listen 后取消，worker 在首个持久批次完成后取消；请求停止先取消该计时器。
   启动超时使用同一有界清理路径，整体非零退出；晚到的 provider 不得复活已停止的角色。
   超时计时器保持引用，因此仅有挂起 Promise 的初始化不能悄悄 exit 0。
7. 同镜像 HEALTHCHECK 根据角色选择本地 `/ready` 端口；Web 镜像独立检查 `/healthz`。
   探针不依赖 curl/wget，不跟随重定向，网络等待最多 2 秒。
   required container job 先迁移共享 SQLite volume，再启动三个非 root 角色，等待真实 Docker
   healthy 状态。通过公开 HTTP 注册临时用户、提交并重试同一消息，验证唯一接收人通知、
   排除发送者/非成员、拒绝匿名收件箱，再重启 worker/Web 重跑；启动成功不能替代投递成功。

## 约束与边界

- 不修改 [ADR 0009](0009-message-notification-recipient-timing.md) 的投递时成员规则，
  不修改 [ADR 0038](0038-notification-integrity.md) 的 lease fencing、at-least-once、
  retry/dead-letter、迁移日志与终态保留策略。没有新增自动 redrive、purge 或消息删除功能。
- 这些是本地/镜像/CI 的运行保证，不是公网部署或托管平台资格验收；没有进行部署。
  跨副本 refresh（#318）及实际主机资格验证（#331）仍是独立工作。
- Node 定时器不能抢占同步 `node:sqlite`、阻塞的本地扩展或 CPU 死循环。
  宿主仍应配置略大于应用预算的强制停止期限；SQLite 的 5 秒 busy timeout 不因本决策消失。
  PostgreSQL 异步 row-lock 阻塞由真实进程测试覆盖，预算耗尽会非零退出，未完成 lease 可在到期后恢复。
- 健康探针不公开认证材料，但运行状态仍是运维信息。metrics 默认关闭且无认证；
  监听器仅在受控网络开放。积压告警不得输出通知 payload。
