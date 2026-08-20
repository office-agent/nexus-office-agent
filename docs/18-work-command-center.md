# 18 主对话与实时任务指挥中枢

> 版本：`0.14.0-work-command-center + tiered-memory`  
> 范围：网页端第一入口、可持久主对话、LLM 原生 Skill/Tool 路由、正式任务拆包/分派/承接/交接、轻量消息池与反馈、个人任务实时观察；企业微信继续复用同一 Agent 与工作协同服务。

## 1. 产品形态

首页不再是卡片式仪表盘，也不把 Agent 放在可有可无的侧边抽屉中。工作指挥中枢有三类互不混淆的对象：

1. 主工作对话：企业成员用自然语言描述目标、约束、时限和参与人。对话跨页面持久存在，所有 Agent 入口写入同一条主会话。
2. 正式任务发布栏：同屏显示“我的任务、待承接、我发布、待交接”。任务是执行承诺，必须具备接收对象、产出、验收、时限、能力和容量；模型发起的发布或交接一律先经人工确认。
3. 消息池：全公司或部门内的沟通、同步、征询和反馈。消息不产生负责人、截止时间、验收标准、任务状态或任务确认；仅按当前身份可见范围显示，并可以在原消息下反馈。

管理看板、经营中枢、项目、审批、组织和知识模块仍是正式业务控制面；主对话负责理解、连接和调度，不另造一套业务事实。

## 2. 企业管理闭环

```mermaid
flowchart LR
    G["管理目标与约束"] --> C["主工作对话"]
    C --> S["LLM 选择 Skill"]
    S --> T["权限过滤后的 Tool"]
    T --> M["使命 Mission"]
    M --> P1["定向任务包"]
    M --> P2["开放承接任务包"]
    P1 --> W["个人任务"]
    P2 --> W
    W --> E["执行证据与验收"]
    E --> R["状态/审计/事件回执"]
    R --> C
```

每个任务包必须具备：明确产出、验收标准、所需能力、负责人策略、优先级、截止时间和容量点。正式任务只可定向至已验证的个人，或定向至已验证的部门后由该部门成员承接；不能由模型猜测用户或部门 ID。任务发布要求 `work_task:create`，个人定向追加 `work_task:assign`，部门定向追加 `work_task:assign_department` 和数据范围校验；承接时再次校验当前成员或组织范围。任务状态为：

`published → claimed → in_progress → in_review → completed`

定向任务从 `assigned` 开始；执行中可进入 `blocked` 并在解除后回到 `in_progress`。阻塞需要原因，完成需要至少一个证据引用。系统不把“模型说已完成”当成完成证据。

### 2.1 任务交接链

任务交接不是把 `assignee_id` 直接改成另一个人，而是一条可签收的责任链。发起人必须是当前负责人、发布人或具有任务管理权限的主体，并且拥有 `work_task:handoff`；跨部门目标同时要求 `work_task:handoff_cross_department` 和目标部门数据范围。目标必须是当前有效成员。

发起时系统冻结任务版本、任务正文、验收标准、所需能力、当前证据、截止时间，以及交接说明和文件/资料引用。交接处于 `pending` 时原负责人仍保持责任，任务状态不能推进，避免“资料已交出但负责人消失”的空档。只有目标人以 `work_task:accept_handoff` 签收后，才在同一事务中写入交接结果、以版本 compare-and-set 切换负责人并追加实时事件；退回必须保留原因，负责人不变。后续接手人可以再发起下一棒，形成按时间排序、不可覆盖的链。

文件/资料引用在交接记录中是不可变快照，而不是复制文件正文。查看或下载实际文档仍由原有文件对象权限和版本控制决定；Agent 回答交接进度、责任归属或资料连续性前必须通过交接链查询 Tool 读取当前有权可见的记录。

## 3. LLM 原生路由

路由不是关键词分类器，也不是 Python/TypeScript 中的业务 `if/else`。每次请求按以下顺序构造模型上下文：

1. 服务端解析权威身份、租户、渠道、数据范围和当前权限。
2. Context Provider 读取当前项目、目标、风险、行动、个人任务、可承接任务、人员 ID 与容量事实，并明确标记为不可信业务数据。
3. Skill Registry 提供声明式能力说明和使用约束；Skill 只提供认知指导，不直接产生业务副作用。
4. Tool Registry 先按当前权限、渠道、风险等级和禁用策略过滤，再以原生 function/tool definition 交给模型。
5. 模型决定直接回答，或调用一个/多个 Tool。服务端对模型参数执行结构校验、权限重验、风险确认、版本校验、幂等与超时控制。
6. Tool 结果以 tool message 返回模型生成最终答复；UI 同时展示 `上下文 → Skill → Tool → 执行回执`，便于核验实际路线。

确定性代码只负责安全和一致性约束，不替模型做业务语义判断。Prompt Injection 检测属于安全边界，不是业务路由器。

首批 Skill：

- `work-orchestration`：目标拆包、分派、承接、交接和任务推进。
- `management-risk`：风险分析与受确认登记。
- `meeting-preparation`：会议事实包、议程和复盘准备。
- `enterprise-analysis`：基于引用的企业经营分析。
- `company-communication`：把非任务沟通放入当前可见的公司或部门消息池，并支持原位反馈。
- `enterprise-memory`：分级检索用户、任务和情景上下文；长期记忆必须由用户确认写入。
- `knowledge-collaboration`、`process-assistance`：在授权范围内检索知识、准备会议、读取流程和生成只读预审材料。

首批任务 Tool：

- `work.publish_task_bundle`：一次发布一个使命及多个任务包；R2、幂等写入。
- `work.claim_task_package`：以当前任务版本主动承接；R1、compare-and-set。
- `work.update_my_task`：推进本人负责或发布的任务；R2、完成/阻塞证据门禁。
- `work.initiate_task_handoff`：冻结版本、任务快照和文件/资料引用后发起正式交接；R2、强制人工确认。
- `work.respond_to_task_handoff`：由目标接收人签收或退回交接；R2、强制人工确认，签收时原子切换负责人。
- `work.get_task_handoff_trail`：只读查询完整交接链、资料快照和签收结果；R0。
- `communication.publish_message`：R1 消息池推送；不产生任务对象、期限、验收或确认提案。
- `communication.add_feedback`：R1 消息池反馈；只能指向当前可见消息。
- `memory.recall`：R0 检索本人及授权共享的长期记忆。
- `memory.remember`：R2 保存用户明确确认的稳定记忆；共享范围再验权限。
- `office.read_governance_workspace`、`office.read_enterprise_intelligence`、`office.prepare_operating_insight`、`knowledge.search`、`meeting.prepare`、`workflow.read_snapshot`、`workflow.pre_review`：R0 跨企业办公模块的只读依据 Tool。

## 4. 数据与实时性

`0017_work_command_center.sql` 新增五张任务租户表，`0018_work_message_pools.sql` 新增三张消息租户表并为任务包增加部门目标字段，`0019_work_task_handoffs.sql` 新增交接链；`0022_agent_memory.sql` 新增分级记忆：

- `work_conversations`：每位成员最多一个活动主会话。
- `work_conversation_messages`：用户、Agent 与 Tool 消息；按 run/role 幂等。
- `work_missions`：对目标的发布记录；Agent run 维度幂等。
- `work_packages`：可分派、承接和验收的最小执行单元。
- `work_task_events`：单调递增 sequence 的任务事件账本。
- `work_pool_messages`：公司或部门池中的轻量沟通内容。
- `work_pool_feedback`：消息下的沟通反馈，不与任务证据混用。
- `work_message_events`：单调递增 sequence 的消息/反馈更新提示。
- `work_task_handoffs`：任务每一棒的责任、冻结任务快照、文件/资料引用、签收/退回结果和 Agent 幂等来源。
- `agent_memory_entries`：分级对话、上下文、长期、任务和情景记忆；带来源、可见性、数据分级、到期、版本、RLS 与原子审计。详见 [分级记忆设计](./22-tiered-agent-memory.md)。

所有表启用并强制 RLS，业务变更触发原子摘要审计。任务承接和状态更新在同一租户事务中以版本条件更新并追加事件，避免双重承接或“状态变了但事件丢失”。消息池不承担任务治理，但仍保留租户隔离、当前可见范围过滤和审计；其事件流只提示刷新，不含未授权正文。

网页通过 `GET /api/v1/task-command/events` 建立 SSE。客户端可使用 `Last-Event-ID` 或 `after` 游标恢复；服务端每 55 秒主动关闭，浏览器自动重连。SSE 是状态变化提示，页面每次都重新读取权限化 workspace，不能把事件负载当成权威完整对象。

## 5. HTTP 契约

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/v1/task-command/workspace` | 读取主会话、消息、人员容量、我的/待承接/我发布任务 |
| `POST` | `/api/v1/task-command/missions` | 人工发布一个使命与任务包集合 |
| `POST` | `/api/v1/task-command/packages/{id}/claim` | 用 `expectedVersion` 主动承接 |
| `POST` | `/api/v1/task-command/packages/{id}/transition` | 用 `expectedVersion` 推进状态、提交证据或阻塞原因 |
| `GET` | `/api/v1/task-command/packages/{id}/handoffs` | 查询当前身份可见的完整交接链和资料快照 |
| `POST` | `/api/v1/task-command/packages/{id}/handoffs` | 发起正式交接，保留原负责人至目标签收 |
| `POST` | `/api/v1/task-command/handoffs/{id}/response` | 目标接收人签收或退回交接 |
| `GET` | `/api/v1/task-command/events` | 可恢复的实时任务事件流 |
| `POST` | `/api/v1/task-command/message-pools/messages` | 直接发布一条公司/部门消息，不创建任务 |
| `POST` | `/api/v1/task-command/message-pools/messages/{id}/feedback` | 对可见消息补充反馈，不改变业务状态 |
| `GET` | `/api/v1/task-command/message-events` | 可恢复的消息池刷新事件流 |
| `POST` | `/api/v1/agent/runs` | 在指定 `conversationId` 中创建主 Agent 运行 |
| `GET` / `POST` | `/api/v1/memory` | 读取或以当前主体明确意图写入长期记忆 |
| `DELETE` | `/api/v1/memory/{id}` | 用版本 CAS 使记忆失效，保留审计链 |

企业微信文本、菜单和卡片动作进入现有连接器身份/验签边界后，调用同一个 Agent Orchestrator 与 TaskCommandService。企业微信不实现自己的关键词分流，不保存另一份任务状态。

## 6. 并发、失败与恢复

- 两人承接同一 `published v1` 任务时，只有第一个 compare-and-set 成功；另一方收到 `409 WORK_PACKAGE_VERSION_CONFLICT`。
- Agent 重试同一 run 的任务发布时，`source_run_id` 唯一约束返回原任务，不创建第二个使命。
- 模型在 Tool 已成功后失联，系统返回确定性 Tool 回执，并标记模型降级，不谎报失败或重复执行。
- 模型不可用且没有 Tool 执行时，只返回安全降级答复；不能根据用户文字在服务端猜测写入动作。
- SSE 断线不会丢业务状态；重连后按 sequence 恢复，再读取 workspace 收敛到权威事实。
- 正式任务发布即使是 R2 也强制进入不可篡改提案与人工确认；人工直发 API 则以当前已认证主体、完整字段、接收对象校验和权限/范围门禁为边界。
- 正式任务交接同样强制进入确认；接收人签收前不改变负责人，交接期间冻结任务版本和状态推进，签收与负责人切换/事件写入同一租户事务。
- R3/R4 动作仍走不可篡改提案、确认和持久 Worker；消息池的 R1 推送仅用于沟通，不能借此绕过任务、审批、项目或其他业务写入策略。

## 7. 当前边界

本地工程已覆盖主会话、任务状态、LLM 原生工具调用、权限过滤、CAS 承接、事件游标、RLS 和审计。以下仍属于外部发布 Gate：真实企业微信测试企业中的消息到任务 E2E、真实多成员高并发承接、企业 IdP 即时撤权、目标基础设施恢复/回滚/密钥轮换，以及四周团队试点。开发 Fixture 不代表真实企业数据或生产验收。
