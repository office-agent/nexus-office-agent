# 15 需求追踪与完成边界

## 1. 追踪口径

本表以 M12 的 103 个规范 ID，加上 M13～M15 的 4 个产品原则、5 个任务与沟通规则、1 个安全规则和 2 个验收标准为唯一范围，共 115 个 ID。状态含义：

- `自动验收`：已有领域、API、数据库、安全或性能测试，并在 `tests/behavior-evidence.json` 中绑定精确测试名和失败路径。
- `本地 Gate`：架构或交付约束已由构建、目录边界、运行门禁或静态检查验证。
- `外部 Gate`：本地实现和协议测试已完成，但必须在企业控制的外部环境留存验收证据，不能据此声明生产完成。

`tests/requirement-traceability.test.ts` 自动校验：设计文档恰好包含 115 个规范 ID；已实现项绑定存在的精确测试名和明确失败路径；待完成项不能同时声明为已实现；外部 Gate 不会被本地证据误标为完成。测试首行 ID 只保留为导航元数据，不再作为完成证据。

## 2. 产品原则

| ID | 状态 | 主要实现/证据 |
|---|---|---|
| PR-001 | 自动验收 | `management-loop.test.ts`、`postgres-management-repository.test.ts`、`enterprise-governance.test.ts`：管理对象进入风险—决策—行动—证据—复盘或变更闭环 |
| PR-002 | 自动验收 | `agent-security.eval.test.ts`、`enterprise-intelligence.test.ts`：事实、推断、提案和正式决定分层 |
| PR-003 | 自动验收 | `management-loop.test.ts`、`enterprise-intelligence.test.ts`：Owner 与唯一 Accountable 约束 |
| PR-004 | 自动验收 | `connector-pipeline.test.ts`、`integration-acceptance-api.test.ts`、`client-platform-api.test.ts`：网页/PWA/三平台复用同一对象与应用服务 |
| PR-005 | 自动验收 | `agent-orchestrator.test.ts`、`workflow-governance.test.ts`：建议、草拟、确认后执行与禁用 R4 |
| PR-006 | 自动验收 | `agent-security.eval.test.ts`、`knowledge-permissions.test.ts`：引用、时间、数据范围和不确定性 |
| PR-007 | 自动验收 | `platform-connectors.test.ts`、`test-notification-governance.test.ts`、`client-platform.test.ts`：首选渠道、全局去重和受控通知 |
| PR-008 | 自动验收 | `enterprise-governance.test.ts`、`agent-orchestrator.test.ts`、`test-notification-governance.test.ts`：补偿计划、版本/验收证据绑定和不可篡改确认 |
| PR-009 | 自动验收 | `agent-native-tool-routing.test.ts`：主 Agent 基于完整权限化上下文与声明式 Skill/Tool 自主路由，业务意图不由关键词或固定程序分流 |
| PR-010 | 自动验收 | `task-command-api.test.ts`、网页工作指挥中枢：主对话是第一入口，任务发布、个人任务与主动承接保持同屏实时可见 |
| PR-011 | 自动验收 | `agent-native-tool-routing.test.ts`、`task-command-api.test.ts`：模型在同一主对话中区分正式任务和沟通推送，消息池与任务状态机独立 |
| PR-012 | 自动验收 | `task-command.test.ts`、`agent-native-tool-routing.test.ts`：多人成员交接以签收链传递责任，并持续保留任务、证据与文件/资料快照 |

## 3. 企业管理规则

| ID | 状态 | 主要实现/证据 |
|---|---|---|
| MR-001 | 自动验收 | `enterprise-intelligence.test.ts`：战略主题与目标关联 |
| MR-002 | 自动验收 | `enterprise-intelligence.test.ts`：OKR/KPI 语义分离 |
| MR-003 | 自动验收 | `enterprise-intelligence.test.ts`：Owner、周期、口径、基线、目标、来源和检查频率 |
| MR-004 | 自动验收 | `enterprise-intelligence.test.ts`：目标连接指标与项目 |
| MR-005 | 自动验收 | `enterprise-intelligence-api.test.ts`、`agent-orchestrator.test.ts`：Agent 只能建议，正式状态需人确认 |
| MR-006 | 自动验收 | `enterprise-intelligence.test.ts`、`enterprise-governance.test.ts`：重要对象唯一 Owner |
| MR-007 | 自动验收 | `enterprise-intelligence.test.ts`：RACI 唯一 Accountable |
| MR-008 | 自动验收 | `authorization-policy.test.ts`、`postgres-authorization-resolver.test.ts`：范围、动作、有效期与授权收敛 |
| MR-009 | 自动验收 | `postgres-enterprise-governance.test.ts`：离职/转岗撤权、撤设备、撤外部身份并全量交接 |
| MR-010 | 自动验收 | `enterprise-intelligence.test.ts`：容量只使用计划信号，不生成绩效结论 |
| MR-011 | 自动验收 | `foundation-migration.test.ts`、`enterprise-governance-api.test.ts`：目标、价值、Owner、资源、期限和验收字段强制存在 |
| MR-012 | 自动验收 | `management-loop.test.ts`：风险与已发生问题采用独立状态机 |
| MR-013 | 自动验收 | `postgres-enterprise-governance.test.ts`：逾期、阻塞、风险暴露和预算偏差进入去重关注队列 |
| MR-014 | 自动验收 | `enterprise-governance.test.ts`：原基线、原因、影响、批准人、新基线与版本 |
| MR-015 | 自动验收 | `postgres-enterprise-governance.test.ts`：验收、遗留移交、复盘和数据库结项 Gate |
| MR-016 | 自动验收 | `workflow-governance.test.ts`、`authorization-policy.test.ts`：审批来自策略而不是按钮 |
| MR-017 | 自动验收 | `workflow-governance.test.ts`、`enterprise-governance.test.ts`：高风险职责分离 |
| MR-018 | 自动验收 | `agent-security.eval.test.ts`、`governance-api.test.ts`：AI 预审不改变正式状态 |
| MR-019 | 自动验收 | `workflow-governance.test.ts`：驳回、委托、撤回、并行取消和超时升级显式迁移 |
| MR-020 | 自动验收 | `workflow-governance.test.ts`、`postgres-governance-repositories.test.ts`：运行实例锁定发布版本 |
| MR-021 | 自动验收 | `meeting-governance.test.ts`：讨论、结论、决定和行动分层 |
| MR-022 | 自动验收 | `management-loop.test.ts`、`meeting-governance.test.ts`：议题、选项、依据、决定人与复审日期 |
| MR-023 | 自动验收 | `management-loop.test.ts`、`postgres-management-repository.test.ts`：行动项 Owner、期限、验收标准、来源决定与完成证据 |
| MR-024 | 自动验收 | `management-loop.test.ts`：旧决定保留为 superseded，新决定原子记录 supersedes 关系 |
| MR-025 | 自动验收 | `meeting-governance.test.ts`：纪要经参会确认后幂等沉淀正式决定与行动 |
| MR-026 | 自动验收 | `enterprise-intelligence.test.ts`：绩效事实只取目标、贡献、职责和明确反馈 |
| MR-027 | 自动验收 | `enterprise-intelligence-api.test.ts`：人才包不评分、不排名、不作雇佣决定 |
| MR-028 | 自动验收 | `knowledge-permissions.test.ts`、`postgres-enterprise-intelligence.test.ts`：人才敏感数据严格范围与分类 |
| MR-029 | 自动验收 | `enterprise-intelligence.test.ts`：1:1 默认排除通用 Agent/RAG |
| MR-030 | 自动验收 | `agent-security.eval.test.ts`、`enterprise-intelligence-api.test.ts`：展示使用与排除的数据范围 |
| MR-031 | 自动验收 | `management-intelligence.test.ts`：Owner、时区、频率、议程、角色和关门证据形成管理节奏 |
| MR-032 | 自动验收 | `management-intelligence.test.ts`：节奏实例状态机与关闭证据 Gate |
| MR-033 | 自动验收 | `management-intelligence.test.ts`：AI 会前包只读，区分事实/推断/提案并过滤伪造引用 |
| MR-034 | 自动验收 | `management-intelligence.test.ts`：指标业务定义、公式、Owner/Steward、权威来源、SLA 和用途版本化 |
| MR-035 | 自动验收 | `management-intelligence.test.ts`：missing/stale/unverified/healthy 显式质量状态 |
| MR-036 | 自动验收 | `management-intelligence.test.ts`、`postgres-management-intelligence.test.ts`：情景假设、项目动作、容量、收益、成本、风险和证据 |
| MR-037 | 自动验收 | `postgres-management-intelligence.test.ts`：人工选择校验版本，同一组合唯一 selected，旧选择变为 superseded |
| MR-038 | 自动验收 | `management-intelligence.test.ts`：事项唯一编码、类型、严重度、Owner、SLA、来源和关联对象 |
| MR-039 | 自动验收 | `management-intelligence.test.ts`、`postgres-management-intelligence.test.ts`：事项状态机、Owner 与解决证据 Gate |
| MR-040 | 自动验收 | `management-intelligence.test.ts`：AI 评测只存版本、指标、成本、延迟、结果和证据引用 |
| MR-041 | 自动验收 | `management-intelligence.test.ts`：少于三个样本不输出通过率，未知结果独立计数 |
| MR-042 | 自动验收 | `management-channel-action.test.ts`：企业微信回调重解身份、重算上下文并校验动作引用 |
| MR-043 | 自动验收 | `management-intelligence.test.ts`、`postgres-management-intelligence.test.ts`：接收人只存摘要，确认幂等且原子回写 |
| MR-044 | 自动验收 | `management-intelligence-api.test.ts`：网页派发与渠道确认读写同一版本化事项 |
| MR-045 | 自动验收 | `foundation-migration.test.ts`：八张新租户表全部强制 RLS、至少三类策略和原子审计 |
| MR-046 | 自动验收 | `agent-native-tool-routing.test.ts`：目标拆包只能通过 `work.publish_task_bundle`，每个任务包包含产出、验收标准、能力、时限、优先级与工作量 |
| MR-047 | 自动验收 | `task-command.test.ts`、`task-command-api.test.ts`：任务支持定向分派或公开承接；公开承接以对象版本 compare-and-set 保证唯一承接人 |
| MR-048 | 自动验收 | `task-command.test.ts`：个人任务按显式状态机推进，阻塞必须给出原因，完成必须提供证据，已完成/取消任务退出活动队列 |
| MR-049 | 自动验收 | `task-command.test.ts`、`agent-native-tool-routing.test.ts`：正式任务必须指向经校验的个人或部门并经确认门禁；沟通仅进入可见消息池并支持反馈，不产生任务责任与验收 |
| MR-050 | 自动验收 | `task-command.test.ts`、`postgres-task-command.test.ts`：交接发起冻结版本和资料引用、原负责人保持责任到接收人签收；签收以 compare-and-set 原子切换负责人，完整链可查询 |

## 4. 架构、集成与安全

| ID | 状态 | 主要实现/证据 |
|---|---|---|
| AR-001 | 自动验收 | `foundation-migration.test.ts`、`production-identity.test.ts`：内部 UUID 与外部身份映射分离 |
| AR-002 | 自动验收 | `foundation-migration.test.ts`、各 PostgreSQL 仓储测试：tenant scope 与强制 RLS |
| AR-003 | 自动验收 | `management-loop.test.ts`、`management-api.test.ts`、`enterprise-governance.test.ts`：乐观锁和版本冲突 |
| AR-004 | 自动验收 | `postgres-client-platform.test.ts`、`postgres-acceptance-repository.test.ts`：强制 RLS、原子摘要审计与追加式验收证据 |
| AR-005 | 自动验收 | `events-and-connectors.test.ts`、`audit-event.test.ts`、`test-notification-governance.test.ts`：脱敏摘要、哈希和解析版本 |
| AR-006 | 本地 Gate | `foundation-migration.test.ts`、`production-readiness.test.ts`：模块化单体与统一迁移/运行门禁 |
| AR-007 | 自动验收 | `management-loop.test.ts`、`postgres-management-repository.test.ts`、`postgres-agent-store.test.ts`：应用服务、领域事件和业务事务内 Outbox 边界 |
| AR-008 | 自动验收 | `platform-connectors.test.ts`：业务内核只依赖统一 Connector Port |
| AR-009 | 自动验收 | `postgres-durable-runtime.test.ts`、`postgres-agent-worker.test.ts`：数据库租约、异步 Agent Job、崩溃恢复与人工核对 |
| AR-010 | 自动验收 | `postgres-durable-runtime.test.ts`：完整 Inbox 消费、Outbox 幂等发布回执、租约回收与重试终态 |
| AR-011 | 自动验收 | `pwa-security.test.ts`、`client-platform-api.test.ts`：浏览器只调用 BFF，不保存 Secret |
| AR-012 | 自动验收 | `client-platform.test.ts`、`pwa-security.test.ts`：PWA 复用 BFF/领域内核且离线边界受控 |
| IR-001 | 自动验收 | `events-and-connectors.test.ts`、`platform-connectors.test.ts`、`integration-acceptance.test.ts`：统一连接器契约、能力矩阵与真实预检 |
| IR-002 | 自动验收 | `connector-pipeline.test.ts`：先验证 ExternalIdentity，再加载业务上下文 |
| IR-003 | 自动验收 | `connector-security.test.ts`：三平台验签/解密/时间窗后入队 |
| IR-004 | 自动验收 | `connector-security.test.ts`、`postgres-durable-runtime.test.ts`：验签后完整信封持久化、Inbox 消费、租约回收与幂等重放 |
| IR-005 | 自动验收 | `platform-connectors.test.ts`、`postgres-durable-runtime.test.ts`：首选渠道去重、生产 Outbox Dispatcher 与发布回执 |
| IR-006 | 自动验收 | `platform-connectors.test.ts`、`agent-job-control.test.ts`、`postgres-agent-worker.test.ts`：限流、未知结果、有限重试和有证据人工核对 |
| IR-007 | 自动验收 | `platform-connectors.test.ts`、`production-operations.test.ts`：数据库只存 secret_ref，运行时受管解析 |
| SR-001 | 自动验收 | `production-identity.test.ts`、`postgres-authorization-resolver.test.ts`：每请求从权威库重算权限，不信会话内陈旧授权 |
| SR-002 | 自动验收 | `foundation-migration.test.ts`、`authorization-policy.test.ts`：tenant scope 与跨租户拒绝 |
| SR-003 | 自动验收 | `connector-security.test.ts`、`knowledge-permissions.test.ts`、Agent 恶意输入评测 |
| SR-004 | 自动验收 | `request-context-security.test.ts`、`agent-orchestrator.test.ts`：授权源/策略不可用时失败关闭 |
| SR-005 | 自动验收 | `audit-event.test.ts`、`production-operations.test.ts`、Secret/Bundle 扫描 Gate |
| SR-006 | 自动验收 | `authorization-policy.test.ts`、`agent-orchestrator.test.ts`：Agent 权限继承并进一步收窄 |
| SR-007 | 自动验收 | `agent-native-tool-routing.test.ts`：Tool Registry 在送入模型前按实时权限、渠道、风险和禁用策略过滤；服务端在执行前再次校验 |

## 5. 验收标准与外部边界

| ID | 状态 | 主要实现/证据 |
|---|---|---|
| AC-001 | M11 + 外部 Gate | 本地已有连接器预检和局部共享状态证据；需先完成持久化四渠道链路，再执行三平台真实测试企业 E2E |
| AC-002 | 自动验收 | `management-api.test.ts`、`postgres-management-repository.test.ts`、`governance-api.test.ts`、`postgres-enterprise-governance.test.ts` 覆盖多个完整管理旅程 |
| AC-003 | 自动验收 | `foundation-migration.test.ts`、`postgres-authorization-resolver.test.ts`、`postgres-agent-worker.test.ts`：RLS、即时撤权和执行前再授权 |
| AC-004 | 自动验收 | `agent-api.test.ts`、`postgres-agent-worker.test.ts`：确认只排队、Worker 二次鉴权、过期权限失败关闭 |
| AC-005 | 自动验收 | `postgres-agent-worker.test.ts`、`postgres-durable-runtime.test.ts`：业务写入后和发布后崩溃均不重复副作用 |
| AC-006 | 自动验收 | `platform-connectors.test.ts`、`agent-job-control.test.ts`、`worker-supervisor.test.ts`：降级、重试、未知结果、人工恢复和瞬时故障隔离 |
| AC-007 | 自动验收 | `agent-security.eval.test.ts`、`knowledge-permissions.test.ts`：重要结论权限正确且可引用 |
| AC-008 | 本地 Gate | Secret、日志、前端 Bundle、PWA、镜像和审计脱敏扫描均纳入 Gate |
| AC-009 | 自动验收 | `local-performance.test.ts` 与 HTTP smoke：本地指标低于架构阈值 |
| AC-010 | 外部 Gate | `production-operations.test.ts` 已验证加密备份与完整性；仍需目标环境执行恢复、回滚、密钥轮换演练 |
| AC-011 | M12 本地 Gate + 外部复核 | `management-intelligence-api.test.ts`、`management-channel-action.test.ts`、`postgres-management-intelligence.test.ts` 已验证同对象、重鉴权、接收人匹配、版本和幂等；真实企业微信仍属于 AC-001 外部 Gate |
| AC-012 | M13 本地 Gate + 外部复核 | `postgres-task-command.test.ts`、`foundation-migration.test.ts` 验证唯一主对话、持久消息、CAS 承接、可恢复事件流、强制 RLS 与原子审计；真实多成员并发和企业微信消息到任务 E2E 仍属于 AC-001/团队试点外部 Gate |
| AC-013 | M15 本地 Gate + 外部复核 | `task-command.test.ts`、`postgres-task-command.test.ts`、`foundation-migration.test.ts` 验证连续多人交接、文件/资料快照、签收责任切换、强制 RLS 与原子审计；真实团队跨部门交接采用、文件存储与企业微信卡片签收仍属于 AC-001/团队试点外部 Gate |

## 6. M11 持久运行契约

| ID | 状态 | 主要实现/证据 |
|---|---|---|
| DR-001 | 自动验收 | 完整事件信封持久化后才可被 Inbox Worker 领用 |
| DR-002 | 自动验收 | `FOR UPDATE SKIP LOCKED` 与不可预测租约令牌保证独占领用 |
| DR-003 | 自动验收 | 过期租约安全回收，旧令牌 compare-and-set 失败 |
| DR-004 | 自动验收 | 有限预算、退避、失败分类、死信与未知终态 |
| DR-005 | 自动验收 | 卡片动作重新解析连接、外部身份和当前业务授权 |
| DR-006 | 自动验收 | Outbox 发布回执以事件 ID 唯一，发布后崩溃重放不重复 |
| DR-007 | 自动验收 | R3 确认返回 `202` 与 Job 引用，HTTP 不执行工具副作用 |
| DR-008 | 自动验收 | 本人撤销未开始任务；特权人员凭证据核对、单次重放、确认终态或记录补偿，并追加审计 |
| DR-009 | 自动验收 | Readiness 真实检查最新迁移、同版本 Worker 心跳和 OTLP 回执 |
| DR-010 | 自动验收 | `production-workbench-facts.test.ts`、`workspace-bootstrap.test.ts`：生产工作台事实只来自认证接口，项目显式选择，空状态不造数，Agent 202 任务轮询至有证据终态 |
| DR-011 | 自动验收 | Web、三类 Worker、迁移和运维制品使用同一 `0.14.0` 发布线 |
| DR-012 | 自动验收 | 机器清单绑定精确测试名、失败路径、发布版本和全量验证命令 |
| DR-013 | 自动验收 | 关闭信号停止新领用、当前任务到安全点，过期租约可由其他实例回收 |
| DR-014 | 自动验收 | 租户轮转、角色预算、背压指标和数据库级租户并发槽 |

## 7. 不能在本地消除的发布 Gate

| Gate | 当前状态 | 完成证据 |
|---|---|---|
| 企业 IdP | 待外部执行 | 真实 OIDC 租户登录、MFA/停用、会话撤销和审计记录 |
| 飞书/钉钉/企业微信 | 待外部执行 | 三个测试企业的安装、身份、事件、卡片确认、写回和故障恢复录像/日志 |
| 灾备与密钥轮换 | 待外部执行 | 目标基础设施上的 RPO/RTO、恢复校验、应用回滚和双密钥窗口记录 |
| 四周团队试点 | 待外部执行 | 至少两个真实管理闭环、事故为零、指标与用户反馈记录 |

因此，本地 Gate 通过只能说明“工程实现和本地证据完整”，不能代替沙箱、灾备和试点 Gate。
