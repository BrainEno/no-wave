# 通知账户归属与页面恢复隔离

## 行为和边界

通知铃铛、写作台通知列表、未读角标、旧页游标和显式已读操作属于同一个经过 API 验证的账户。可读 session marker 只是「可能有会话」的提示：不同账户可以有相同 marker，它不能充当账户 ID，也不能授权私有请求。

风险为高：跨标签登录、cookie 轮换、页面隐藏和异步响应会同时影响私有内容与已读状态。实现仅收紧 Web 的请求预条件和展示生命周期；API 仍负责认证、通知归属、分页和持久化授权。本轮不更改数据库、后端权限、推送、生产限流、媒体归属或私信协议。

### 验收情景

- 给定旧页面展示账户甲的通知，另一标签已将 cookie 切换为乙；当旧页面点击单条或全部已读时，请求仍限制为甲，代理返回 `409 ACCOUNT_CHANGED`，不读取或改写乙的通知。
- 给定账户验证还没完成或暂时失败；当用户尝试已读时，不发出未绑定的 mutation。通知首次验证失败也不退回无账户限制的私有读取。
- 给定任一通知请求发现账户冲突；当控制器发布结果时，账户 ID、两处列表、总数、分页位置与 pending 一次清空，并在同一快照提供可恢复的说明。
- 给定发生冲突；当用户再次点击已读时，不隐式确认乙。只有显式读取或一次新的页面连接可以重新验证、接受乙；恢复读取不会重放旧操作。
- 给定页面隐藏或触发 `pagehide`；当事件返回前，两处私有通知 DOM 和角标已经移除，请求已撤销。后台 `online` 和已排队的恢复不能复活旧内容。
- 给定页面重新可见、获得焦点，或从隐藏／BFCache 恢复；当重新验证成功后，只读取当前已验证账户的通知。普通首次 `pageshow` 不额外重试失败的初次验证。

## Web HTTP 预条件

四条 Web 通知路由接受可选头 `x-expected-notification-actor`：历史列表、未读数、全部已读、单条已读。它与私信的限制头不同，不混用两个业务表面。

- 发送端对账户 ID 做一次 `encodeURIComponent`，接收端严格检查单个 URI component 后只解码一次。
- 编码值最多 3,600 字符，解码后 ID 最多 300 字符，拒绝空值、首尾空白、控制字符、损坏的百分号或 UTF-8。ID 不假定为 UUID；Unicode、内部空格、逗号和字面百分号均可在正确编码后保留。
- 有头时，代理使用后续资源请求相同的 verified bearer 先调用 `/api/v1/me`；不匹配即停止。refresh 之后必须再次验证，不能沿用旧 bearer 的账户结果。
- 头只会缩小请求可以针对的账户，不能建立身份，也不会转发给 API。没有凭据时不会因提供头而登录。
- 没有该头的既有调用保持兼容，继续依赖 API 本身的认证与归属检查。
- mutation 仍按方法、同源 Origin、资源 ID、账户预条件的次序拒绝非法请求；不把跨源请求变成资源存在性探针。错误与成功响应均维持 `no-store`。

这里复用共享 forwarder 的单次 refresh 协议，而不是在浏览器先检查账户后再发送不带限制的写请求；后者仍会在 cookie 切换时竞争。上游对过期 bearer 的既有一次轮换逻辑不等于允许账户冲突后的应用自动重放。

## 通知控制器和传输

每个 mounted shell 拥有独立控制器，不使用模块级私有缓存或浏览器持久化存储。SSR 快照没有账户、列表或总数。`connect(true)` 先撤销上一代工作并清空，再验证 `/api/authoring/session`；不能从 marker 推导身份。

验证与资源作业均受代际和当前 job 的有效性约束。晚到的身份、401、列表页或已读 acknowledgement，即使测试 transport 忽略取消，也不能覆盖新连接。验证结果发布时，订阅者可能开始退出登录，因此排队的读取还需在发布后检查代际；同样不能在已读结果发布触发退出后继续查询总数。

资源请求捕获自己的 actor：列表和总数在一次刷新中一起确认；追加旧页保留其原游标和 actor；单条／全部已读及之后的权威总数核对始终使用提交时的 actor。mutation 在总数核对完成前仍串行，重复点击不会发出第二次写入。无 actor 的已读请求不会启动验证或 fetch。

账户冲突清空全部私有状态。一般网络／解析／超时错误则保留同账户最后确认的内容，供显式读取重试；失败的身份查询不能把上次账户恢复为 fallback。401 仍作为会话失效处理，不伪装成成功的空收件箱。

传输维持 1 MiB 响应字节上限、严格 UTF-8／JSON、8 秒默认期限、调用方取消、`same-origin` 凭据、`no-store` 与拒绝重定向。已读操作无 body、不附加幂等键、不在传输层自动重试；只有匹配 ID 和合法 `readAt` 的单条 acknowledgement，或合法非负整数的 mark-all acknowledgement，才确认读取。`409` 必须通过同样的有界 JSON 检查，并仅将精确 `ACCOUNT_CHANGED` 映射为账户冲突，不暴露上游诊断。

权威未读总数继续来自服务器，不 clamp 到已加载的未读行数。mark-all 返回的 changed-row 数不是未读总数或时间戳；不能据此捏造零或 `readAt`。既有多类型／unknown 通知展示、keyset 分页和停滞游标检查保留。

## 恢复与已提交写入

恢复绑定只监听焦点、可见性、上线、`pagehide` 与相关 `pageshow`，不增加轮询。事件边界通过 provider 注入的 `flushSync` 同步清空共享 UI；effect 初始化和清理直接清空 store，不在 React 生命周期内调用 `flushSync`。可见性或 cookie 读取异常均 fail closed。

恢复始终是新的身份验证加只读核对，不重放 mutation。取消浏览器请求不能撤销已经在原账户提交的服务器写入：例如 mark-all 已提交但 acknowledgement 被延迟时，原账户可能已读；新账户仍未读，晚到的旧 acknowledgement 不能改变它的 UI 或触发第二次 mark-all。

显式读取／新连接允许在验证后接受替换账户，这是通知的契约。不要把这个行为推广到私信的原账户固定与不确定发送意图恢复；它们继续保留自己更严格的 actor、payload、key 和导航保护规则。

通知和私信现在是同一页面上两个独立的身份验证消费者。既有私信 E2E 的身份故障夹具必须覆盖整段故障时间，不能只让抢到第一个 `/session` 请求的组件失败；否则故障会被铃铛或私信中的任意一方「消耗」。兼容测试明确断言恢复时两次独立验证、手动私信重试仅增加一次验证，同时继续保护首次私信只读 fallback、恢复后禁止 fallback、原账户限制、无 mutation 重放和原始 draft/key。

## 回归验证位置

- `packages/web-http/test/notification-actor.test.ts`：四路由的凭据一致性、限制头编码／负例、身份失败、轮换后重核和 legacy 兼容。
- `packages/web-ui/src/lib/notification-actor-transport.test.ts`：身份形状、运行时未绑定调用、限制头、精确冲突码、有界解析、取消和期限。
- `packages/web-ui/src/lib/notification-actor-controller.test.ts`：共享归属、冲突原子清空、禁止 mutation 重新绑定、身份／分页／ack 竞争及登录退出栅栏。
- `packages/web-ui/src/lib/notification-actor-recovery.test.ts`：同步事件 flush、初始 pageshow、隐藏／可见恢复、排队事件和可见性异常。
- `e2e/notification-actor.spec.ts` 与 `e2e/notification-recovery-actor.spec.ts`：真实账户、HttpOnly cookie、两处已挂载 UI、未读持久化、同 marker 换号、真实退出及延迟响应。既有 bell fixture 显式模拟已验证 session，不靠 marker 绕过身份验证。

新增 Node 测试均加入根 `pnpm test` 清单；完整验收还包括真实 PostgreSQL 根套件和独立 integration、Web 构建／HTTP、四个全新数据库的完整浏览器 inventory、字体离线配方，以及当前 PR 精确 HEAD 的真实 CI／CodeQL。中文反馈沿用已包含的字形，字体守门和已提交字体产物不作豁免或改写。通过本地检查不代表 CI 或部署成功。
