# ADR 0053: 用 Notion OAuth 代替粘贴令牌，授权结果只交给当前页面、服务器仍不保存

- Status: Proposed
- Implementation: Not started
- Date: 2026-11-22
- 关联：[ADR 0052](0052-server-side-notion-pull-without-storing-tokens.md)（本文沿用其「token 只随请求经过、从不保存」的约束，只替换 token 的来源）；[ADR 0036](0036-notion-as-interchange-format.md) 决定 3

## 背景

ADR 0052 让作者粘贴内部集成的令牌，由服务器分段拉取数据库。这样作者不用再导出
文件，但仍要做三件事：在 Notion 的「设置 → 连接 → 开发或管理集成」里新建内部
集成、复制 Internal Integration Secret、再到数据库的「… → 连接」里添加这个集成。
其中最容易出错的是最后一步：Notion 返回的「未共享」错误（`NOTION_NOT_SHARED`）
几乎都因为漏了这一步。

Notion 的公开集成（public integration）支持 OAuth 2.0 授权码流程。作者点一个按钮，
在 Notion 的授权页里选择要共享的页面或数据库，然后回到本站。上面三步因此合成一步，
「添加连接」也在授权页里一并完成。

代价是 OAuth 一定会经过服务器：用授权码换令牌需要集成的 client secret，它不能出现在
浏览器里。本 ADR 决定要不要做、做的话令牌怎么处理。**本 ADR 只是提案，不包含实现。**

## 备选方案

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 一次性 OAuth（建议）** | 服务器用授权码换到 access token 后，只交给发起授权的那个写作台页面，放在页面内存里；之后完全按 ADR 0052 使用，服务器不保存 | 去掉建集成、复制令牌、添加连接三步，保持 ADR 0052 的不变量 |
| B. 保存令牌 | 每位作者一行加密的 access/refresh token，支持「保持连接」、定时同步 | 需要密钥管理、断开连接与轮换、账户删除时清除，并再次修订 ADR 0036 决定 3；目前没有需求证明值得 |
| C. 维持现状 | 只支持粘贴令牌（ADR 0052）和上传导出文件 | 可用，但操作步骤最多 |

## 建议的决定（方案 A）

### 1. 流程

1. 作者在「连接 Notion 直接拉取」页签点「用 Notion 授权」。页面先请求
   `POST /api/authoring/notion-oauth/start`（BFF → API `POST /api/v1/imports/notion/oauth/start`）。
   API 生成 32 字节随机 `state`，写入 HttpOnly、`Secure`、`SameSite=Lax`、`Path` 仅限回调路径、
   有效期 10 分钟的 `__Host-` cookie，并在其中绑定当前会话的用户 id；返回 Notion 授权地址
   （`client_id`、`response_type=code`、`owner=user`、固定的 `redirect_uri`、`state`）。
2. 页面用**弹出窗口**打开授权地址，写作台页面本身不离开，已有的勾选和内存状态得以保留。
3. Notion 重定向到 `/write/notion/oauth/callback?code=…&state=…`。回调页立即用
   `history.replaceState` 清掉地址栏里的 code，响应头带 `Referrer-Policy: no-referrer` 和
   `Cache-Control: no-store`，再把 `{code, state}` POST 给
   `/api/authoring/notion-oauth/exchange`（BFF → API）。
4. API 校验 `state`：与 cookie 做常量时间比较，确认未过期、属于同一会话用户，然后立即
   作废 cookie（一次性）。接着用 HTTP Basic（client id + secret）调用 Notion 的令牌端点，
   换到 access token。响应 `{accessToken, workspaceName}` 带 `no-store`，**不写库、不写日志**。
   出站请求沿用 ADR 0052 决定 3 的限制：只访问 `api.notion.com:443`、不跟随重定向、响应
   字节有上限、有超时。
5. 回调页通过同源 `BroadcastChannel`（频道名带上第 1 步生成的、只存在于发起页内存里的
   随机 nonce）把 token 交给发起页，然后关闭自己。不依赖 `window.opener`：将来若加上
   `Cross-Origin-Opener-Policy`，opener 关系会被切断，频道仍然可用。发起页只接受
   nonce 匹配的第一条消息。
6. 发起页拿到 token 后，与粘贴的令牌完全一样地使用：放进输入框背后的内存状态，
   调用 ADR 0052 的 `POST /api/v1/imports/notion/fetch`。刷新或离开页面后即失效。

### 2. 令牌处理（不变量，与 ADR 0052 相同）

- 服务器不保存 access token、refresh token、授权码或 `state` 以外的任何 OAuth 数据；
  `state` 只存在于短期 cookie 中。
- 错误、日志、指标、响应中都不出现 token、授权码、client secret 和 Notion 的错误原文。
- 浏览器端不写 `localStorage`/`sessionStorage`/URL/cookie；回调页不渲染 token。
- Notion 若返回 refresh token，直接丢弃，不返回给浏览器：需要「保持连接」时由方案 B
  另立 ADR。

### 3. 配置与默认值

- 新增 `NOTION_OAUTH_CLIENT_ID`、`NOTION_OAUTH_CLIENT_SECRET`、`NOTION_OAUTH_REDIRECT_URI`。
  三者缺一则功能关闭：start 返回 409，写作台不显示授权按钮，粘贴令牌照常可用。
- client secret 只放在 API 进程的环境变量里，BFF 和浏览器都拿不到。
- `redirect_uri` 按完全相等匹配，与 Notion 集成设置中登记的一致；不接受请求参数里的回调地址。

### 4. 限流

新增策略：start 与 exchange 各为每位作者 10 次、每个 IP 20 次 / 10 分钟。与 ADR 0052 的
拉取限流（60/120）以及导入限流（10/20）互相独立。

### 5. 撤销

服务器不保存令牌，本站因此没有「断开连接」可做。写作台说明：要撤销访问，请在 Notion 的
「设置 → 连接」里移除本站集成，之前发出的 token 随之失效。

## 后果

- 作者一次点击加一次 Notion 授权页，就能列出数据库条目，不必再建内部集成、复制令牌，
  也不会再因为漏了「添加连接」而失败。
- 风险与 ADR 0052 相同：token 在服务器内存中只停留换取和每次拉取的时长。新增的风险
  面是 client secret，它泄露后可以冒充本站集成发起授权（但拿不到任何已有 token，因为
  我们不保存）。需要轮换流程和密钥托管。
- 每次导入都要重新授权（Notion 可能记住之前的选择，使第二次更快）。这是不保存令牌的
  直接代价，可以接受。
- 需要以公开集成的身份在 Notion 登记，并提供隐私政策和服务条款地址，这是运营层面的
  工作。

## 实施前必须核实的事项

以下内容依据的是对 Notion 公开集成的一般理解，**落地前要逐条对照 Notion 当前文档核实**：

1. 授权地址与参数（`owner=user`），令牌端点及其 HTTP Basic 认证方式。
2. access token 是否会过期、是否返回 refresh token、是否支持 PKCE（支持就一并启用）。
3. 公开集成上线是否需要 Notion 审核，以及审核对隐私政策和数据用途的要求。
4. 授权页里的页面选择能否直接选中数据库，以及只选父页面时子数据库是否随之共享。
5. 公开集成令牌访问数据源 API（`/v1/data_sources/...`）的权限与内部集成是否一致。

## 不在本 ADR 范围内

保存令牌和「保持连接」（方案 B）、定时同步、写回 Notion、Flutter 端的 OAuth（原生端
可自行完成授权，再按 ADR 0036 决定 8 提交 bundle），以及持久化导入任务
（[ADR 0041](0041-default-off-notion-import-jobs.md)，仍为 Proposed）。

## 验证计划（实施时）

- API：start 与 exchange 的参数校验，`state` 不匹配、过期、重放、跨用户时一律拒绝；
  功能关闭时返回 409；限流生效；Notion 令牌端点用桩代替，捕获日志并断言其中没有 token、
  授权码和 secret。
- BFF：同源校验、`no-store`、cookie 属性。
- 写作台：nonce 不匹配的消息被忽略；token 不进入存储和 URL；拿到 token 后走与粘贴令牌
  相同的拉取路径。e2e 模拟 start、exchange 和回调，不连接 Notion。
