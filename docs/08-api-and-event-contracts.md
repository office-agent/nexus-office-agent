# 08 API 与事件契约

## 1. API 约定

基础路径：`/api/v1`。所有响应携带 `traceId`，错误使用稳定 code，不把内部异常和供应商响应原样返回。

### 1.1 请求上下文

服务端从会话推导：

```ts
type RequestContext = {
  tenantId: string;
  actorId: string;
  sessionId: string;
  channel: "web" | "feishu" | "dingtalk" | "wecom";
  traceId: string;
  policyContext: PolicyContext;
};
```

客户端不得指定 tenantId 或冒充 actorId。

### 1.2 错误格式

```json
{
  "error": {
    "code": "POLICY_DENIED",
    "message": "你没有执行此操作的权限",
    "details": {},
    "retryable": false
  },
  "traceId": "..."
}
```

### 1.3 写操作

- 支持 `Idempotency-Key`。
- 使用 `If-Match` 或 version 进行并发控制。
- R3/R4 动作返回 proposal，不直接执行。

## 2. 主要资源 API

```text
/session /me /organizations /users
/objectives /key-results /metrics
/portfolios /projects /milestones /tasks
/risks /issues /decisions /action-items
/meetings /documents /knowledge/search
/process-definitions /process-instances /approvals
/agent/runs /agent/proposals /confirmations
/integrations /integrations/:id/sync /integrations/:id/health
/notifications /inbox
/task-command/workspace /task-command/missions /task-command/templates /task-command/message-pools/messages
/task-command/templates/:id
/task-command/packages/:id/claim /task-command/packages/:id/transition /task-command/packages/:id/handoffs
/task-command/handoffs/:id/response
/task-command/events
/admin/policies /admin/audit /admin/models
```

经营管理写入遵循同一闭环契约：带 `riskId` 的决定或问题必须引用当前租户、同一项目中的风险；决定、行动项与对应 Outbox 事件在同一租户事务中提交。行动完成与任务状态迁移必须提交当前 `version`，服务端使用 compare-and-set 拒绝丢失更新；行动进入 `completed` 时必须同时保存非空完成证据。版本冲突返回 `409`，不存在的关联对象返回 `404`。

会议确认转化的决定保存 `sourceMeetingId`，服务端校验来源会议和决定属于同一租户、同一项目；行动项通过 `decisionId` 关联该决定。知识搜索只返回当前已生效且未过期版本，并在引用中返回原始 `sourceRef`、版本定位、有效时间和不泄露 ACL 明细的 `accessBasis`。

## 3. Agent API

### 创建运行

`POST /api/v1/agent/runs`

输入包含 message、contextRefs 和 clientRequestId；服务端解析身份与权限。返回 runId 和流式事件地址。

主工作对话调用还包含 `conversationId`，用户消息、Agent 最终答复和实际 Skill/Tool 路由会幂等写回该会话。

### 运行事件

- run.started
- retrieval.completed
- response.delta
- proposal.created
- confirmation.required
- tool.started
- tool.completed
- run.completed
- run.failed

### 确认

`POST /api/v1/agent/proposals/:id/confirm`

必须携带 proposalHash；服务端重新校验权限、策略、对象版本和有效期。成功返回 `202 Accepted`、唯一 `jobId` 和状态查询地址，只创建持久化 Agent Tool Job，不同步执行工具。重复确认返回同一任务；执行前 Worker 再次鉴权。

## 4. 领域事件

```ts
type DomainEvent<T> = {
  id: string;
  type: string;
  version: number;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  actor: { type: "user" | "agent" | "system"; id: string };
  traceId: string;
  causationId?: string;
  correlationId?: string;
  payload: T;
};
```

首期事件：

- objective.activated / objective.status_changed
- project.approved / project.status_changed
- milestone.at_risk
- risk.identified / risk.realized / risk.closed
- decision.decided / decision.superseded
- action_item.assigned / action_item.overdue / action_item.completed
- approval.requested / approval.decided
- meeting.record_confirmed
- integration.event_received / integration.sync_failed
- agent.proposal_created / agent.action_executed
- work.mission_published / work.package_published / work.package_claimed / work.package_status_changed

## 5. 事件兼容

- 事件只追加字段，不改变既有字段语义。
- 破坏性变化提升 version，并保留旧消费者过渡期。
- 消费者忽略未知字段。
- Schema 存放在代码仓并通过契约测试验证。

## 6. Outbox/Inbox

业务事务写 aggregate 和 outbox 同一事务。Dispatcher 使用租约领用，并以 eventId 写入唯一发布回执；消费者使用 eventId 写 inbox 去重。失败按类型进入有限重试、结果未知或死信，旧租约令牌不能提交终态。完整协议见 [持久化执行设计](./16-durable-runtime.md)。

## 7. Webhook 处理

接入路由：

```text
/api/integrations/feishu/events
/api/integrations/dingtalk/events
/api/integrations/wecom/events
```

公开路由只做协议验证、大小限制、完整统一事件信封的幂等持久化和 ACK，不执行模型推理或复杂业务。平台长连接事件调用同一内部 ingestion service。数据库持久化失败时不得返回成功 ACK。

## 8. Deep Link

平台卡片链接只传内部 opaque reference，不传敏感业务值。打开网页后重新认证、授权并读取最新状态。确认动作不能只依赖 Deep Link 参数。

## 9. 管理智能中枢 API 与事件

M12 的完整资源 API 见 [17 管理智能中枢](./17-management-intelligence-web-wecom.md)。新增领域事件包括：

- `management_cadence.created`
- `cadence_occurrence.prepared` / `cadence_occurrence.status_changed`
- `metric_semantic_profile.updated` / `metric_quality.checked`
- `portfolio_scenario.created` / `portfolio_scenario.selected`
- `enterprise_case.created` / `enterprise_case.status_changed`
- `ai_governance.evaluated`
- `management_channel_action.created` / `management_channel_action.executed`

所有写 API 仍使用请求上下文推导租户和主体、以版本拒绝丢失更新，并通过与业务事实相同的数据库事务追加 Outbox 事件。
