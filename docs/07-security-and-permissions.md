# 07 权限、安全与合规

## 1. 零信任原则

- `SR-001` 每次请求重新解析租户、用户、会话和权限，不信任客户端传入角色。
- `SR-002` 所有业务查询带 tenant scope，跨租户访问默认拒绝。
- `SR-003` 外部文档、消息、模型输出、Webhook 和工具响应均是不可信输入。
- `SR-004` 策略服务不可用时，写操作失败关闭。
- `SR-005` Secret 只存在密钥管理器或受控本地环境，不进入数据库明文、源码、日志和模型 Prompt。
- `SR-006` Agent 不拥有独立超级权限，始终继承和收窄当前用户权限。

## 2. 权限模型

有效权限：

```text
RBAC 角色能力
∩ ABAC 属性条件
∩ 数据范围
∩ 字段权限
∩ 对象状态允许动作
∩ 渠道能力
∩ Agent/工具风险策略
```

### 2.1 RBAC

基础角色：TenantAdmin、SecurityAdmin、IntegrationAdmin、Executive、Manager、PMO、Member、HR、Finance、Auditor。管理员角色分离，不设单一“万能管理员”用于日常工作。

### 2.2 数据范围

- self：本人数据。
- owned：本人负责对象。
- team：当前直接团队。
- org_subtree：部门及下级。
- project：项目成员范围。
- explicit：显式 ACL。
- tenant：全租户，仅少数治理角色。

### 2.3 ABAC 条件

包括租户、组织、岗位、对象分类、项目成员、地区、时间、设备信任、操作风险和工作流状态。

## 3. 敏感数据

| 等级 | 示例 | 默认规则 |
|---|---|---|
| Public | 公开制度、产品资料 | 可按租户策略外发 |
| Internal | 一般项目、内部会议 | 仅企业成员与授权应用 |
| Confidential | 预算、客户、合同、人才盘点 | 严格数据范围、禁止通用模型默认处理 |
| Restricted | 薪酬、身份凭据、密钥、安全事件 | 字段加密、专门审批、最小保留 |

模型路由、日志、导出、分享和索引都必须读取分类标签。

## 4. 身份与会话

- 网页支持企业 SSO，优先 OIDC，兼容 SAML。
- 外部平台身份通过经过验证的 ExternalIdentity 映射内部 User。
- 管理员账号支持 MFA；高风险确认可要求二次验证。
- 会话使用 HttpOnly、Secure、SameSite Cookie，具备绝对与闲置超时。
- OAuth `state`、PKCE（适用时）、redirect_uri 白名单和单次 code 校验。
- 离职/停用事件立即撤销会话、令牌引用和未完成委托。

实现说明：会话中的角色、权限和数据范围不参与生产授权决定。服务端每次请求读取权威用户状态和未到期 `user_roles`；因此停用、离职或角色到期无需等待 Cookie 过期。数据库/授权解析不可用时返回安全失败，不回退到会话内旧权限。

## 5. Agent 安全

- Prompt 与业务数据分层，文档内容不能覆盖系统政策。
- 工具调用基于 Schema，拒绝任意 URL、SQL、Shell 和动态代码执行。
- 对 R3/R4 操作生成不可篡改 proposal_hash 并确认。
- 模型只看到完成权限过滤后的必要数据。
- 输出执行前重新校验对象版本和权限，防止 TOCTOU。
- 外发文本进行敏感数据检查；高敏感命中进入人工复核。

## 6. Webhook 与连接器安全

- HTTPS、平台签名、时间窗口、nonce 和防重放。
- 飞书 HTTP 模式使用 Encrypt Key/Verification Token。
- 钉钉优先 Stream SDK；HTTP 模式按官方协议验签解密。
- 企业微信校验 msg_signature、AES 解密并验证 receiveid。
- HTTP 回调只在协议校验通过后写入租户隔离的持久 replay claim；合法 duplicate 返回平台成功 ACK，但不重复进入业务 Inbox。
- Callback replay fingerprint 只绑定平台、连接、时间戳、nonce、签名和正文摘要；不保存原始或解密后的消息内容。
- URL 中的 tenant 仅为兼容路由提示，可信 tenant、provider 与 secret_ref 必须来自精确匹配的服务端连接记录。
- 原始回调限制大小、解析深度和内容类型。
- 每连接器独立限流、熔断和权限范围。
- Token 刷新采用单飞锁，日志仅记录 secret_ref 和状态。

## 7. 审计事件

审计事件至少包含：

```text
event_id / occurred_at / tenant_id
actor_type / actor_id / impersonator_id?
channel / session_id / trace_id
action / resource_type / resource_id
decision: allowed|denied|executed|failed
policy_id / policy_version
before_digest / after_digest
confirmation_id / agent_run_id / tool_call_id
source_ip_hash / device_trust
```

高风险审计追加写并定期导出到独立不可变存储。审计查询本身也记录审计。

数据库为每个带 `tenant_id` 的业务表安装行级变更触发器，使业务写入与摘要审计在同一事务内提交或回滚。触发器只记录动作、资源标识、调用主体、渠道、trace 与前后摘要，不复制原始业务字段或密文；`audit_events` 对应用角色仅开放租户范围内的 `INSERT/SELECT` RLS 策略，不开放 `UPDATE/DELETE`。独立不可变存储导出仍是生产发布 Gate，不以数据库内追加写替代外部留存。

## 8. 安全测试 Gate

- 跨租户和横向越权测试全部拒绝。
- Agent Prompt Injection 不能改变工具和权限策略。
- 未确认 R3/R4 操作无法执行。
- Secret 扫描、日志扫描和前端包检查无凭据。
- Webhook 伪造、重放、过期时间戳和错误 receiveid 被拒绝。
- 依赖漏洞无未处置的 Critical/High。
- 备份恢复和密钥轮换完成演练。

## 9. 隐私与员工保护

- 明示平台收集范围和 Agent 使用数据范围。
- 不以监控员工为目标，不建立隐性“勤奋度”评分。
- 1:1、绩效、薪酬和健康相关数据默认排除通用搜索。
- 提供用户数据访问、更正和删除流程。
- AI 对人员的建议必须可解释、可申诉并由人负责最终决定。
