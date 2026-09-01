# 06 飞书、钉钉、企业微信连接器设计

## 1. 集成目标

网页是完整管理与配置入口；飞书、钉钉、企业微信承担轻量查询、通知、卡片确认、机器人对话和事件输入。三者不各自维护业务状态。

- `IR-001` 所有平台接入必须实现统一 ConnectorPort。
- `IR-002` 外部身份映射到内部用户后才能访问业务上下文。
- `IR-003` 平台事件先验签/鉴权，再进入业务队列。
- `IR-004` 外部写入必须有幂等键、重试预算和审计。
- `IR-005` 通知路由尊重用户首选渠道并全局去重。
- `IR-006` 平台不可用时网页核心功能仍可用。
- `IR-007` 平台 Secret 仅保存于密钥管理器，数据库保存 secret_ref。

## 2. 统一连接器接口

```ts
interface CollaborationConnector {
  provider: "feishu" | "dingtalk" | "wecom";
  verifyInstallation(input: InstallationInput): Promise<InstallationStatus>;
  exchangeOrRefreshToken(input: TokenInput): Promise<TokenMetadata>;
  resolveIdentity(input: ExternalIdentityInput): Promise<IdentityCandidate>;
  listOrganizations(cursor?: string): Promise<Page<ExternalOrg>>;
  listUsers(cursor?: string): Promise<Page<ExternalUser>>;
  sendMessage(command: SendMessageCommand): Promise<ExternalReceipt>;
  updateInteractiveMessage(command: UpdateMessageCommand): Promise<ExternalReceipt>;
  normalizeInboundEvent(raw: VerifiedRawEvent): Promise<UnifiedEvent[]>;
  healthCheck(): Promise<ConnectorHealth>;
}
```

连接器还必须暴露 capability matrix，不能假定所有平台能力一致。

## 3. 统一事件信封

```json
{
  "eventId": "provider stable id or derived hash",
  "provider": "feishu|dingtalk|wecom",
  "connectionId": "internal connection id",
  "tenantId": "resolved tenant id",
  "eventType": "message.received",
  "occurredAt": "ISO-8601",
  "externalActor": { "type": "user", "id": "opaque external id" },
  "externalContext": { "chatId": "opaque", "threadId": "opaque" },
  "payload": {},
  "rawDigest": "sha256",
  "schemaVersion": 1,
  "traceId": "internal trace id"
}
```

核心事件类型：`message.received`、`card.action`、`user.changed`、`department.changed`、`meeting.changed`、`approval.changed`、`installation.changed`。

## 4. 飞书

### 4.1 应用形态

- 企业自建应用。
- 机器人能力。
- 网页应用嵌入飞书工作台。
- 服务端 API 权限按最小范围申请。

### 4.2 事件模式

优先使用官方 SDK 长连接接收事件和卡片回调：无需公网回调地址，SDK 封装鉴权；长连接采用集群分发，不保证每个实例都收到同一事件，因此内部必须持久化和幂等。

生产可选 HTTP Webhook 作为兼容模式：必须配置 Encrypt Key 和 Verification Token，完成签名、解密、防重放和快速 ACK。

### 4.3 身份与权限

- 应用身份使用 tenant_access_token，权限范围由应用决定。
- 用户身份使用 user_access_token，权限范围继承用户授权。
- 日历等部分事件仅支持用户身份，应在 capability matrix 中显式表达。
- 应用权限或事件变更需要发布新版本并由企业管理员审核后生效。

### 4.4 限流和失败

- 处理 HTTP 429，并尊重 `x-ogw-ratelimit-reset`。
- 回调业务逻辑不在 ACK 前执行。
- 消息发送错峰、合并并设置 per-user/per-chat 限额。

官方依据：

- [企业自建应用开发流程](https://open.feishu.cn/document/develop-process/self-built-application-development-process?lang=zh-CN)
- [事件订阅概述](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM)
- [长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [频控策略](https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control?lang=zh-CN)

## 5. 钉钉

### 5.1 应用形态

- 企业内部应用，后续 SaaS 化时增加第三方企业应用。
- 应用机器人、互动卡片、H5 工作台入口。
- Client ID/Client Secret 通过密钥引用管理。

### 5.2 事件模式

优先使用 Stream 模式：官方 SDK 通过 WebSocket 连接，支持机器人回调、事件订阅和卡片回调，不要求公网回调地址，也不需要自行解密事件。

HTTP 推送仅作私有化兼容：数据为密文，必须验签和解密；官方当前不推荐作为默认路径。

### 5.3 处理规则

- Stream handler 只完成验证、完整统一事件信封入库与 ACK；业务处理由持久化 Inbox Worker 完成。
- 事件失败返回延后处理状态，内部同时记录重试。
- 测试和生产使用不同应用，避免开发 Stream 客户端消费生产事件。
- 多实例采用租约和 connection owner，避免超出连接数和重复副作用。

官方依据：

- [Stream 模式推送服务端](https://open.dingtalk.com/document/orgapp/develop-stream-mode-push-server.md)
- [事件订阅概述](https://developers.dingtalk.com/document/development/event-subscription-overview)
- [服务端 Stream 模式](https://open.dingtalk.com/document/resourcedownload/Introduction-to-stream-mode.md)

## 6. 企业微信

### 6.1 应用形态

- 企业自建应用。
- 应用主页指向响应式 Web/PWA。
- 应用消息、菜单、网页授权和消息事件回调。

### 6.2 回调模式

企业微信使用 HTTPS 回调。配置 URL、Token、EncodingAESKey：

1. GET 验证 URL 时校验 `msg_signature`、解密 `echostr` 并在要求窗口内返回明文。
2. POST 事件时校验签名、AES 解密 XML、验证 receiveid。
3. 按 MsgId 或稳定字段组合排重。
4. 快速返回 200，业务异步处理；平台超时可能重试。

### 6.3 身份与授权

- CorpID + 应用 Secret 获取 access_token，Secret 不得出现在 URL 日志。
- 网页 OAuth code 单次使用且短时有效；校验 state 和可信域名。
- 默认使用低敏感 scope；需要详细成员信息时单独申请并解释用途。

### 6.4 限流

- 按企业、应用、IP 和具体 API 执行本地限流。
- 应用消息还受每成员和每日人次限制。
- 即使 API 返回成功，也要考虑平台可能因频率丢弃消息，重要通知需要回执或状态确认。

官方依据：

- [自建应用与消息接收概述](https://developer.work.weixin.qq.com/document/path/90238)
- [应用能力概述](https://developer.work.weixin.qq.com/document/90000/90135/90226)
- [获取访问用户身份](https://developer.work.weixin.qq.com/document/path/91023)
- [网页授权链接](https://developer.work.weixin.qq.com/document/path/91120)
- [访问频率限制](https://developer.work.weixin.qq.com/document/path/96212)

## 7. HTTP 回调防重放与业务幂等

公开回调中的 `tenant_id` 仅用于兼容既有平台 URL 的路由提示，不是授权事实。服务端必须以 `tenant_id + connection_id + provider` 精确查询处于可接收状态的连接，且只能从该连接的 `secret_ref` 解析回调密钥；验签后的统一事件必须使用连接记录中的 tenant、connection 和 provider，绑定不一致时失败关闭。

HTTP 回调按以下顺序处理：连接绑定与 transport 校验 → Secret 解析 → 时间窗/签名/Verification Token 或 receiveid/密文校验 → URL Challenge 快速响应或持久化 replay claim → 事件标准化 → Inbox 原子 claim → 平台 ACK。协议校验失败的请求不得写 replay 或 Inbox。

`webhook_replay_claims` 只保存 tenant、connection、provider、服务端 SHA-256 fingerprint、原始正文摘要、首次接收时间和过期时间，不保存回调或解密正文。Fingerprint 绑定平台、连接、平台时间戳、nonce、签名和正文摘要；`INSERT ... ON CONFLICT DO NOTHING` 保证多实例并发下只有一个 replay claim。过期摘要按可信服务器接收时间清理。

Callback replay 与 Inbox 幂等是两层不同保护：前者识别同一 HTTP 传输回调并稳定其首次接收时间，后者按统一业务事件 ID 拦截不同封装或不同 transport 的重复事件。Replay claim 写入后若 Inbox 首次持久化失败，平台重试仍使用首次接收时间重新尝试 Inbox，不能仅凭 replay duplicate 返回成功。只有 Inbox 已存在时才报告 duplicate；合法 duplicate 不属于认证失败，仍返回飞书、钉钉或企业微信要求的成功 ACK，且不得触发业务副作用。URL Challenge 完成协议验证后直接响应，不进入 replay 或业务 Inbox。

## 8. 消息与卡片设计

统一消息语义：

- info：只读信息。
- action_required：需要用户处理。
- confirmation：Agent 高风险动作确认。
- status_update：长任务状态。
- digest：合并摘要。

卡片必须包含稳定 action_id、proposal_hash、expires_at 和 deep_link。平台回调只携带最小引用，服务端重新加载最新业务状态并重新鉴权，禁止信任客户端回传的金额、角色或目标对象。

## 9. 安装与租户绑定

安装流程：创建 Connection 草稿 → 管理员录入/授权凭据 → 能力探测 → 组织范围选择 → 初次同步 → 身份冲突处理 → 机器人测试 → 发布连接。

连接状态：`draft → verifying → syncing → active → degraded → suspended → revoked`。

## 10. 同步策略

- 组织和用户：首次全量 + 事件增量 + 每日对账。
- 消息：只接收应用可见和用户主动交互的内容，不声称获取平台不允许的数据。
- 日历/会议：按用户授权和平台能力同步。
- 写回：优先平台 API；失败时保留内部事实与待重试状态。
- 冲突：外部组织字段按来源优先级，内部管理对象不被外部同步覆盖。

## 11. 企业接入验收控制面

`0.11.0` 首次将“已配置环境变量”与“真实可用”分开；`0.12.0-durable-runtime` 进一步要求真实 Worker 心跳和持久化旅程证据。管理员在网页执行的预检会真实调用后端，并以 `passed` / `failed` / `blocked` 三态追加证据：

- OIDC：本地配置结构、Discovery issuer/HTTPS 端点、JWKS 可读性与密钥数量。
- 连接器：连接状态、外部企业显式绑定、回调密钥引用解析、真实令牌换取、平台身份 API。
- HTTP 200 中的平台错误码仍视为失败；缺凭据、受管密钥服务或企业绑定时视为 `blocked`，绝不转成通过。
- `enterprise_acceptance_runs` 只允许 INSERT/SELECT，保存步骤码与安全摘要，不保存 Secret 原文。

出站测试通知是真实副作用，不得用一个“测试”按钮直接发送。控制面要求：连接已激活、最新五步预检全通过、先生成绑定收件人 SHA-256 摘要的 5 分钟方案，再由同一管理员确认。数据库不保存收件人原文。如果请求可能已写出但平台没有返回可靠回执，结果记为 `unknown` 并停止自动重试，由人工核对。
