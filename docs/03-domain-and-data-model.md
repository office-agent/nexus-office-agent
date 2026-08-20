# 03 领域与数据模型

## 1. 领域边界

首期采用模块化单体，按领域模块组织代码和数据库访问：

| 模块 | 主要对象 | 权威职责 |
|---|---|---|
| Identity | Tenant、User、Identity、Session | 租户和身份映射 |
| Organization | OrgUnit、Position、Membership、Delegation | 组织、岗位、成员和授权 |
| Strategy | StrategyTheme、Objective、KeyResult、Metric | 战略目标和度量 |
| Delivery | Portfolio、Project、Milestone、Task、Dependency | 项目执行 |
| Governance | Risk、Issue、Decision、Change | 风险、问题和管理决定 |
| Workflow | ProcessDefinition、ProcessInstance、Approval | 流程与审批 |
| Collaboration | Meeting、ActionItem、Comment、Notification | 协作与行动 |
| Knowledge | Document、KnowledgeItem、Citation | 文档与知识 |
| Agent | AgentProfile、AgentRun、ToolCall、Confirmation | Agent 运行和确认 |
| Integration | Connection、ExternalIdentity、SyncCursor、InboundEvent | 外部连接器 |
| Audit | AuditEvent、SecurityIncident | 不可抵赖审计 |

企业治理扩展对象：`OrganizationChangeCase`、`WorkHandoff`、`ProjectChangeRequest`、`ProjectClosureReview`、`ManagementAttentionItem` 和 `CompensationPlan`。这些对象不是旁路日志，而是组织撤权、项目变更、管理升级、结项和逆向补偿的权威状态机。

## 2. 通用字段

所有租户业务表至少包含：

```text
id UUID/ULID
tenant_id
version
status
created_at / created_by
updated_at / updated_by
archived_at
data_owner_org_id
classification
source_system
source_external_id
```

- `AR-001` 业务 ID 不包含平台用户 ID，外部 ID 通过映射表维护。
- `AR-002` 所有查询必须显式携带 tenant scope。
- `AR-003` 关键对象使用乐观锁 version 防止覆盖更新。
- `AR-004` 审计数据追加写，业务删除不级联删除审计事件。
- `AR-005` 外部事件保存脱敏原始摘要、哈希和解析版本，不长期保存无必要的消息全文。

## 3. 核心关系

```mermaid
erDiagram
  TENANT ||--o{ USER : contains
  TENANT ||--o{ ORG_UNIT : contains
  USER ||--o{ MEMBERSHIP : has
  ORG_UNIT ||--o{ MEMBERSHIP : includes
  OBJECTIVE ||--o{ KEY_RESULT : contains
  OBJECTIVE }o--o{ PROJECT : realized_by
  PROJECT ||--o{ MILESTONE : contains
  PROJECT ||--o{ TASK : contains
  PROJECT ||--o{ RISK : exposes
  PROJECT ||--o{ DECISION : governed_by
  MEETING ||--o{ DECISION : produces
  DECISION ||--o{ ACTION_ITEM : creates
  USER ||--o{ ACTION_ITEM : owns
  PROCESS_DEFINITION ||--o{ PROCESS_INSTANCE : instantiates
  PROCESS_INSTANCE ||--o{ APPROVAL : contains
  AGENT_RUN ||--o{ TOOL_CALL : invokes
  AGENT_RUN ||--o{ CITATION : uses
  CONNECTION ||--o{ EXTERNAL_IDENTITY : maps
  CONNECTION ||--o{ INBOUND_EVENT : receives
```

## 4. 状态机

### 4.1 项目

`draft → proposed → approved → active → paused → closing → completed|cancelled`

只有 `approved` 后才允许分配正式预算；`completed` 前必须满足验收 Gate。

### 4.2 风险

`identified → assessed → response_planned → monitoring → realized|closed|accepted`

风险必须记录 probability、impact、exposure、owner、response 和 review_at。

### 4.3 决策

`draft → under_review → decided → executing → verified → superseded|closed`

### 4.4 Agent 动作

`planned → policy_checked → awaiting_confirmation → approved|rejected → executing → succeeded|failed → compensated?`

## 5. 外部身份映射

一个内部用户可映射多个外部身份：

```text
ExternalIdentity
- tenant_id
- connection_id
- provider: feishu | dingtalk | wecom
- subject_type: user | department | chat | app
- external_subject_id
- internal_subject_type
- internal_subject_id
- mapping_status
- verified_at
```

禁止用姓名或手机号在运行时自动合并用户。自动匹配只能生成候选，必须通过可信标识或管理员确认。

## 6. 事件与幂等

InboundEvent 唯一键：`tenant_id + provider + connection_id + external_event_id`。

若平台不提供稳定事件 ID，则使用规范化字段计算幂等哈希，并记录算法版本。处理流程：

1. 验签/解密。
2. 计算幂等键。
3. 持久化接收记录。
4. 快速 ACK。
5. 异步解析和业务处理。
6. 写处理结果、重试状态和审计 ID。

## 7. 知识与引用

KnowledgeItem 不直接等于文件。它保存：

- 来源文档与版本。
- 权限快照和数据分类。
- 有效期、发布状态和替代关系。
- 文本切片和向量索引引用。
- 引用定位信息。

检索结果必须在检索前和返回前各执行一次权限过滤，防止索引侧和生成侧越权。

## 8. 数据保留

| 数据 | 默认保留 | 说明 |
|---|---|---|
| 业务对象 | 租户策略 | 支持归档和合法删除 |
| 外部事件正文 | 7～30 天 | 原则上仅保留必要字段与哈希 |
| Agent Prompt/Response | 30～180 天 | 可按数据分类缩短或关闭 |
| ToolCall 和确认记录 | 不低于审计要求 | 不保存 Secret |
| 安全审计 | 1～7 年 | 由合规策略决定 |
| 知识索引 | 跟随源文档 | 源权限或版本变化时立即失效 |
