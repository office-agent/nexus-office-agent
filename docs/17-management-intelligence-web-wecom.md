# 17 企业管理智能中枢：网页端与企业微信一期

> 版本：`0.13.0-management-intelligence`  
> 状态：M12 实施基线  
> 边界：网页是完整控制面，企业微信是轻量处置面；二者共享 PostgreSQL 权威事实、权限、审计和事件。

## 1. 管理目标

一期把现有目标、项目、风险、决定、行动和证据扩展为五类可持续管理机制：管理节奏、指标语义、项目组合情景、企业事项和 AI 质量治理。平台不替代 ERP、CRM、财务核算或 HRIS，只消费这些系统提供的权威事实。

## 2. 管理规则

- `MR-031` 管理节奏必须定义 Owner、时区、频率、议程模板、参与角色和关门证据，不能只创建日历提醒。
- `MR-032` 节奏实例按 `scheduled → preparing → ready → in_progress → awaiting_evidence → closed` 迁移；关闭必须提供结果证据。
- `MR-033` AI 会前包只读，严格区分事实、推断和提案，返回引用、使用范围和排除范围，不改变正式状态。
- `MR-034` 指标语义档案必须包含业务定义、公式、Owner、Steward、权威来源、新鲜度 SLA、允许用途和禁止用途。
- `MR-035` 指标质量必须显式显示 `missing|stale|unverified|healthy`，不得把缺数据或过期数据包装成正常。工作区例外摘要分别统计失鲜/缺失和待核验指标；会前事实包使用同一条最新质量解释。
- `MR-036` 项目组合情景必须记录假设、项目动作、容量、预期收益、成本、风险和证据，支持可复核比较。
- `MR-037` 情景选择是人工决定，必须校验当前版本；同一组合只能有一个已选择情景，旧选择保留历史。
- `MR-038` 企业事项必须有唯一编码、来源、类型、严重度、Owner、SLA、关联对象和证据链。
- `MR-039` 事项状态按 `open → triaged → in_progress → awaiting_evidence → resolved|closed` 迁移；解决和关闭必须提供证据。
- `MR-040` AI 治理评测只保存模型/提示版本、数据集引用、质量指标、成本、延迟、结果和证据摘要，不保存原始敏感提示或完整响应。
- `MR-041` AI 质量看板必须显示样本量和未知项；样本不足时不得输出误导性通过率。
- `MR-042` 企业微信卡片动作必须重新解析外部身份，并校验当前权限、动作哈希、有效期和对象版本。
- `MR-043` 企业微信发送必须幂等，只持久化收件人摘要；没有平台回执时标记 `unknown`，禁止自动推断成功。
- `MR-044` 网页与企业微信必须操作同一业务对象；卡片和 Deep Link 不得携带敏感业务值或成为第二事实源。
- `MR-045` M12 新增的所有租户表必须启用强制 RLS、原子摘要审计和跨租户拒绝。

## 3. 核心对象

| 对象 | 关键内容 | 正式状态由谁改变 |
|---|---|---|
| `ManagementCadence` | Owner、频率、时区、议程、证据要求 | 管理员/Owner |
| `CadenceOccurrence` | 时间、状态、会前包、结果证据 | Owner/被授权管理者 |
| `MetricSemanticProfile` | 定义、公式、血缘、Steward、用途限制 | 指标管理员 |
| `MetricQualityCheck` | 新鲜度、完整性、证据和质量状态 | 权威采集或人工确认 |
| `PortfolioScenario` | 假设、项目动作、容量、收益、成本、风险 | 组合审批人 |
| `EnterpriseCase` | 来源、SLA、责任、状态和证据 | Owner/被授权处置人 |
| `AiGovernanceEvaluation` | 质量、策略、成本、延迟和人工反馈 | 评测系统/治理人员 |
| `ManagementChannelAction` | 不透明动作引用、哈希、时效、版本和结果 | 当前已验证主体 |

## 4. API 契约

所有 API 使用 `/api/v1/management-intelligence`，身份与租户只从已验证请求上下文推导。响应统一返回 `data` 与 `meta.traceId`；写操作输入必须是严格 Schema，状态迁移携带 `version`。

```text
GET  /workspace

POST /cadences
POST /cadences/:id/occurrences
POST /occurrences/:id/prepare
POST /occurrences/:id/transition

PUT  /metrics/:metricId/semantic-profile
POST /metrics/:metricId/quality-checks

POST /portfolios/:portfolioId/scenarios
POST /scenarios/:id/select

POST /cases
POST /cases/:id/transition

POST /ai/evaluations
GET  /ai/scorecard

POST /wecom/actions
POST /channel-actions/:id/confirm
```

企业微信真实回调继续使用统一入口：

```text
GET|POST /api/v1/integrations/wecom/:connectionId/events?tenant_id=:tenantId
```

公开回调只验签、解密、去重、持久化和 ACK；业务动作由 Inbox Worker 处理。

## 5. AI 会前包

模型输入只包含当前身份有权读取的结构化摘要，不包含 Restricted 数据、原始私聊、1:1、人才标签或凭据。模型输出必须解析为：

```ts
type ManagementBriefing = {
  facts: Array<{ statement: string; evidenceRefs: string[] }>;
  inferences: Array<{ statement: string; confidence: number; evidenceRefs: string[] }>;
  proposals: Array<{ statement: string; requiresHumanDecision: true }>;
  usedDataScopes: string[];
  excludedDataScopes: string[];
  stateChanged: false;
};
```

模型不可用、超时或返回非法结构时，服务必须降级为确定性事实包，并明确标记 `degraded=true`，不得虚构结论。

## 6. 企业微信动作

一期支持：

1. 企业事项“接单并进入处理中”。
2. 管理节奏实例“确认进入会中执行”。
3. 在网页查看完整证据、版本和历史。

发送前创建 `ManagementChannelAction`，卡片只携带 `actionId`、`proposalHash`、`expiresAt` 和网页 Deep Link。确认时通过企业微信外部身份映射得到内部用户，重新解析当前角色、权限和数据范围；动作已经执行时返回同一结果，不产生第二次副作用。

## 7. 本地与外部 Gate

本地 Gate 使用虚构 Fixture 验证：Schema、状态机、权限、RLS、审计、幂等、哈希/时效/版本、企业微信协议形状、模型降级、桌面和 390×844 响应式。真实企业微信安装、成员身份、卡片发送/回调、平台回执和故障恢复仍必须在测试企业独立验收。
