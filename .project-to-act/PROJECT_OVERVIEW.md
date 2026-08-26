# 项目总览

## 基本信息

- 项目名称：枢纽 · 统一办公平台 Agent
- 项目 ID：nexus-office-agent
- 项目负责人：用户 / Codex 协作
- 风险等级：T4（企业数据、多租户权限、跨渠道外部写入、持久 Agent 任务与生产运行治理）
- 当前阶段：M26 MCP/Tool Gateway、M27 Approval/Change Delivery Control Plane、M28 Session Tree/Profile/Delegation、M29 员工端/治理控制面、M30 Model Gateway/Telemetry/Evaluation/Quota、M31 Security/Resilience、M32 Preproduction/Readiness、M33 Pilot Governance 和 M34 Release Governance 本地切片正在收敛；M20.2 实施基线仍是唯一范围与 Gate 依据。M21～M25 的控制面、Runner、Workspace 和资源供应链证据继续作为后续 Gate 的前置事实
- 当前状态：`@earendil-works/pi-coding-agent@0.84.2` 已从 Web 控制面移出，控制面已有 RunManifest/幂等命令/租约/状态查询、独立 `pi-runner`、Workspace/Artifact 契约、M25 Resource Registry/Ed25519 校验/批准灰度撤销/扫描门禁/受控 ResourceLoader/资源快照、M26 MCP Registry/Binding/Schema freeze/Secret Broker/OpenBao 适配器接口/Bridge/Tool Gateway/调用审计/熔断撤销/注入式 egress 边界、Pi MCP Tool 的 Session/Run scope 强制与 PostgreSQL 新写入约束、M27 本地 R2/R3 Approval Policy/R4 禁用/proposal hash/TTL/决策历史/对象版本重验/fail-closed 恢复适配与 Change Delivery 提交/PR/合并/发布提案/system-only dispatch/unknown no-replay、M28 Session Tree/Branch/Summary/Continuity/Profile digest/父子能力交集/预算/深度/并发/循环门禁/委派账本、M29 `PiCodingWorkbench` 员工端 Profile catalog、Session/SSE、Tree、Diff/Artifact/Checkpoint、治理 overview、资源安全投影/动作和 MCP 脱敏摘要、M30 Model Gateway route/policy、数据分类授权、用量成本、Telemetry/Evaluation/Regression Alert、Quota Reservation/消费/释放和运营快照、M31 Kill Switch/不可变安全事件/不可信内容封装/容量租约/开发故障计划/租户范围加密恢复与回退动作摘要、M32 发布候选/Readiness/FailClosed Probe/Secret Lease/预生产事件/强制 RLS/promote/rollback/API/运营门禁、M33 Pilot/旅程/观察/抽检/事故/退出/Readiness/运营摘要和 M34 Publication/Gate/Risk/双人审批/Rollout/回退/撤销/持续评测/运营摘要本地控制面。M26 本地回归证据为 E-053/E-054/E-092/E-093/E-094，M27 本地回归证据为 E-055/E-095/E-096，M28 本地回归证据为 E-056，M29 本地回归证据为 E-057/E-058，M30 本地回归证据为 E-059，M31 本地回归证据为 E-060，M32 本地回归证据为 E-061，M33 为 E-062，M34 为 E-063；E-067 补充 M21/M22 真实 PostgreSQL + 独立 bundle 子进程故障矩阵、interrupt/timeout、事件连续性和沙盒回收证据，E-068 补充真实子进程 graceful drain、draining 心跳、队列不再 claim 和 48 次 bounded soak。真实 PostgreSQL 角色 RLS、100 并发生产旅程、多进程 kill/restart、Firecracker/Kata、Forgejo/S3、真实 OCI/制品签名与扫描供应链、OpenBao/OAuth、隔离测试 MCP、出站代理攻击矩阵、生产模型/OTel/配额对账、实际 Tool pause/resume/PR/合并/发布、Profile/Policy/Quota 生产管理、跨进程 Session/子 Agent 恢复、生产备份/升级回退、Secret/证书轮换、蓝绿/Schema 兼容、7 天 `/ready=200`、24h soak、RPO/RTO、真实四周试点、发布委员会和生产灰度仍未通过，G-029/G-030/G-031/G-032/G-033/G-034/G-035/G-036/G-037/G-038 不通过，不能视为生产能力
- E-095 已补齐 M27 Change Delivery 本地控制面：变更提交、PR/合并/发布提案、审批绑定、证据重验、Postgres 强制 RLS、CAS、system-only dispatch、未知结果终态和安全 Presenter；实际 Forgejo/组织审批/持久 Outbox/外部 pause-resume/合并发布仍由 G-030/G-031 门禁控制。
- E-096 在 E-095 之上补齐本地持久交付骨架：审批等待态只在重新读取对象版本并 CAS 激活后进入 `queued`；`pi-change-delivery` Durable Worker 接入租户轮询；0041 注册 Worker 角色；0042 增加 lease owner/token/expiry 与旧 Worker fencing，过期租约只进入 `unknown` 且不重放外部副作用；服务端 Forgejo Gateway 支持 tenant-scoped credentialRef、OpenBao/受管 Secret 引用、PR 幂等发现、mergeability 刷新和显式开启的合并，外部交付默认关闭，未配置时 fail-closed。聚焦 5 个测试文件/20 项、全量 118 个测试文件/435 项通过、8 个文件/26 个测试跳过，typecheck、零警告 Lint、Pi Runner bundle 和隔离 Next 生产构建通过；当前 Windows 沙盒 preflight 为 `not_ready`，真实 Firecracker/Kata、OpenBao、组织审批人、受控出站和真实 Forgejo/发布目标仍未通过 G-027/G-030/G-031。
- E-097 在 E-096 之上补齐 Pi Runtime 的企业 Tool policy/approval wiring：新增受控 inline `enterprise-policy-extension`，由 ResourceLoader 在最终资源快照后强制注入；未知 Tool、未分类风险、超 Profile 上限和 R4 均 fail-closed，R0/R1 直通，R2/R3 在同一 Pi Tool 调用内创建持久 Approval Proposal、等待决策，并在批准后按当前 Session/Run 的 manifestDigest、profileVersion、policyVersion、sandboxRunId 二次重验后恢复执行；拒绝、过期、撤销、取消、中断、对象漂移和等待超时均不执行 Tool。Pi Runner 已将 awaiting_approval、approval_required、approval_resumed、approval_denied 写入 Run/Session 事件并保持租约心跳；生产 Runner 的 approver directory 当前为 fail-closed，真实组织审批目录、微 VM、模型/Tool 执行、OpenBao/受控出站和 G-027/G-030/G-031 仍未通过。聚焦 4 个文件/32 项、全量 119 个测试文件/441 项通过、8 个文件/26 个测试跳过，typecheck、零警告 Lint、Pi Runner bundle 和隔离 Next 生产构建通过；`pi-sandbox:preflight` 当前为 `not_ready`/本次退出 1，Docker Desktop 可用但不替代 Firecracker/Kata。回退停止 Runner 的 approval service/高风险 Tool consumer，保持审批与高风险执行 fail-closed，保留事件/提案事实并回到 E-096 制品。
- E-099 已完成公开开源快照：当前源码、测试、通用设计文档、脱敏功能清单和开源交接手册以 Apache-2.0 许可证发布到 https://github.com/redmaplewww/nexus-office-agent 的 main，公开提交为 `3fee719840976943e3eedae492585898093c768f`；内部 `.project-to-act`、真实部署证据、环境文件、运行产物和企业地址未发布。该公开提交仍是 `0.14.0-work-command-center` 工程候选，不改变 G-027～G-038 的 no-go 结论。
- E-102 已按用户明确要求更新公开仓库：当前验证源码、测试、文档与完整 `.project-to-act` 台账已推送至上述仓库 `main`，公开提交为 `da7dbf3`；本地 `test-artifacts/` 生成物、环境文件与真实部署证据未推送。该提交只代表源码交付，不改变 `0.14.0-work-command-center` 工程候选及 G-027～G-038 no-go 边界。
- 最后更新：2026-08-26

## 项目目标

- 构建以企业目标为中心，连接战略、组织、项目、流程、会议、知识、经营数据和 Agent 的管理操作系统。
- 首期同时提供网页、飞书、钉钉、企业微信四个交互渠道，共享同一领域、权限、工作流和审计内核。
- 完成“项目风险发现 → 管理决策 → 行动落实 → 追踪复盘”的真实纵向闭环。
- 建立可解释、可确认、可审计、可评测的企业 Agent 平台。
- 以 Pi Agent 为统一 Agent Runtime，建设云端代码持久化、隔离沙盒执行、统一 Skill/MCP、受控模型路由和多 Agent 协作的企业开发平台。
- 员工只通过 Web/PWA/APP 对话与交互；代码、模型调用、工具执行、构建、测试、审计和交付全部在服务端受控运行。
- 后续在统一 BFF 和领域内核上开发自建桌面/移动客户端，不被任何外部协同平台锁定。

## 范围

### 包含

- 网页/PWA 管理平台与员工工作台。
- 租户、身份、组织、角色、数据范围、策略和审计。
- 战略/目标、项目/任务、风险/问题、决策/行动项。
- 流程审批、会议知识、经营视图和通知中心。
- Agent 上下文、工具、确认、执行、引用、评测和模型治理。
- Pi Agent 控制面、独立 Runner、会话树、恢复、压缩、Profile、受限子 Agent 和执行事件流。
- 云端 Workspace、Forgejo/Git 分支、检查点、Diff、测试报告、扫描报告、Artifact 与 Pull Request 交付。
- Firecracker/Kata 沙盒、出站网络代理、Skill/Package/Extension Registry、MCP Bridge、Tool Gateway、审批和策略治理。
- 飞书企业自建应用、钉钉企业内部应用、企业微信自建应用的连接器框架和真实协议接入。
- 单元、集成、连接器契约、E2E、安全、性能和故障测试。
- 生产部署、监控、备份、回滚和试点交付材料。

### 非目标

- 不取代专业 ERP、CRM、财务核算和完整 HRIS。
- 不绕过平台开放能力获取未授权历史聊天或敏感数据。
- 不允许 Agent 在无政策和确认的情况下执行财务、人事、权限或大范围外发等高风险操作。
- 首期不做通用插件市场和完整低代码平台。
- 不允许浏览器或 Next.js Web 进程直接执行 Pi、Shell、Git、MCP 或部署动作。
- 不允许仓库内未知 `.pi/extensions`、`.agents/skills`、Package 或 `AGENTS.md` 获得企业策略以上的信任。
- 不在首期允许 Agent 直接合并受保护分支、部署生产、修改租户权限、处理财务付款或执行不可逆的人事动作。

## 技术路线与关键约束

- Next.js、React、TypeScript；模块化单体优先，边界稳定后按需拆服务。
- PostgreSQL + pgvector 为业务与知识事实源，Redis 用于可重建缓存和协调，对象存储保存文件。
- 领域事件使用 Outbox/Inbox；长任务、Agent 动作和外部写回进入持久化工作流。
- 三平台通过 ConnectorPort、UnifiedEvent、ExternalIdentity 和统一通知协议接入。
- 飞书/钉钉优先官方长连接/Stream；企业微信使用 HTTPS 回调、签名验证和 AES 解密。
- 模型与平台凭据仅从受控环境或部署密钥管理器读取，禁止进入源码、日志和文档。
- 任何有副作用的 AI 动作必须经过策略检查；R3/R4 操作要求与 proposal_hash 绑定的人工确认。

## Pi 企业统一开发平台目标架构

| 平面 | 模块 | 核心职责 | 强制边界 |
|---|---|---|---|
| 体验面 | Web/PWA/APP、管理控制台 | 对话、事件展示、Diff/Artifact 查看、审批、配置管理 | 不持有模型 Key、MCP Token、Git 凭据或执行能力 |
| API 控制面 | BFF、Session API、Capability Catalog | 解析身份/租户/项目，创建命令，返回只读视图与事件游标 | 客户端提交的 tenant/actor/权限字段一律不可信 |
| Agent 控制面 | Agent Controller、Profile Resolver、Policy/Approval Gateway | 固化运行快照、调度 Run、授权 Tool、暂停/恢复、交付编排 | 不在 Web 请求内运行 Pi；执行前必须重新授权 |
| 执行数据面 | Pi Runner、Firecracker/Kata Sandbox、Workspace Agent | 运行 Pi SDK、文件/Shell/Git/测试、收集事件和产物 | 每个 Run 独立隔离；无宿主、Kubernetes API、Docker Socket 和长期凭据 |
| 能力面 | Skill/Package/Extension Registry、MCP Bridge、Tool Gateway | 签名发布、能力解析、Schema 固化、服务端执行 | Skill 只提供认知；权限只由服务端策略授予 |
| 资源面 | Forgejo、PostgreSQL/RLS、Redis/Queue、对象存储、OCI Registry | 代码、会话、队列、Artifact、镜像和版本事实源 | tenant_id、对象前缀、加密上下文与短期授权共同隔离 |
| 模型面 | Model Gateway、Provider Adapter、数据分类策略 | 模型选择、流式调用、限额、成本、脱敏和私有模型路由 | Secret 不进入模型上下文；Restricted 默认禁止外发 |
| 治理面 | Audit、Telemetry、Evaluation、Quota、Security Operations | 追踪、评测、成本、告警、撤销、取证和发布 Gate | 遥测不保存原始 Secret；审计不可由业务角色改写 |

### 不可妥协的运行不变量

1. 一个 `agent_run_id` 只绑定一个租户、一个主体、一个 Workspace 快照、一个基线 Commit 和一个 Sandbox。
2. Pi Runtime 只接收服务端冻结的 `RunManifest`；运行期间不能自行扩大 Profile、Skill、Tool、模型、网络或数据范围。
3. 所有 Tool Call 必须同时经过 Runner 内拦截和服务端 Tool Gateway 校验；任一侧不可用即失败关闭。
4. Sandbox 默认无公网，只能通过带租户、目的域名、协议和审计上下文的出站代理访问白名单目标。
5. Git、对象存储、MCP、模型和日志均以 `tenant_id + workspace_id + run_id` 约束；跨租户命中必须拒绝并产生安全事件。
6. Session 状态、事件序列、审批、Tool Call、Checkpoint、Artifact 和 Git Commit 必须持久化后才可对外宣称成功。
7. 未知结果不得自动重放有副作用动作；先进入人工核对或补偿路径。
8. 主分支合并、生产发布、权限/财务/人事写操作不属于 Pi 沙盒能力，必须调用独立受控 Tool 并满足职责分离。
9. Skill、Extension、Package、Runner 镜像、策略和 MCP Server 均使用不可变版本与摘要；撤销后新 Run 不得解析到被撤销版本。
10. 生产没有可验证的微 VM 隔离、持久队列和受控密钥时，Pi Session 创建或执行必须返回 not-ready，不得降级到宿主进程。

## 后续工作强制执行协议

- `.project-to-act/` 五份文档是本项目唯一管理事实源；其他 `docs/` 只能作为设计或实现说明，不得覆盖这里的范围、状态、Gate 与版本结论。
- 任一后续实现开始前，必须在 `PROJECT_FEATURES.md` 找到功能 ID 和模块/接口/函数 ID，在 `PROJECT_PROGRESS.md` 找到当前里程碑与依赖，在 `PROJECT_ACCEPTANCE.md` 找到对应 Gate、失败停止条件和回退路径。
- 未被 F-054～F-075 或后续正式新增功能覆盖的工作不得直接编码；确需扩展时先新增 D 记录、功能、里程碑、验收和版本影响。
- 每个实现批次只能推进一个主 Gate；跨 Gate 修改必须说明依赖和共同回退点，避免无法独立回滚的大批量交付。
- 数据库迁移、API、事件、策略、镜像、Skill/MCP 和 UI 变更必须分别形成可复核证据；测试名称或文件存在本身不等于能力通过。
- 状态只能按“已规划 → 进行中 → 已完成”推进；阻塞写入解除条件。未执行真实 Firecracker/Kata、真实 PostgreSQL/RLS、真实对象存储或真实企业 E2E 时，只能标记对应范围的局部 Gate。
- 任何 Gate 失败立即停止扩大范围，按 Gate 回退矩阵恢复最近通过的不可变制品；不得用功能开关掩盖数据不一致、越权或未知副作用。
- 完成批次后先记录新鲜 E 证据，再更新 F/M/A/G/版本状态，最后运行 project-to-act `--validate`；没有证据不得写“已完成”。

## 数据与安全边界

- 业务数据按 Public、Internal、Confidential、Restricted 分级。
- 有效权限为 RBAC、ABAC、数据范围、字段权限、对象状态和 Agent 工具策略的交集。
- 外部事件、文档和模型输出均视为不可信输入。
- 员工绩效和人才数据不得使用聊天频率、在线时长等监控式代理指标直接评价。

## 当前焦点

- 关键路径：M21 契约/队列 → M22 独立 Runner → M23 微 VM/网络 → M24 Workspace/Git/Artifact → M25 资源治理 → M26 MCP/Tool Gateway → M27 审批/交付 → M28 Session Tree/Sub-Agent → M29 前端/管理面 → M30 可观测/评测/配额 → M31 安全/韧性 → M32 预生产 → M33 试点 → M34 发布。
- 外部依赖：Firecracker/Kata 可用集群、Forgejo、PostgreSQL、Redis/持久队列、S3 兼容对象存储、OCI Registry、OpenBao、受控出站代理、OIDC 与试点团队；凭据只通过受控配置工具录入。
- 最后更新：2026-08-20
- 下一里程碑：按顺序补齐 G-025～G-035 的真实调度、微 VM、网络、Forgejo/S3、资源供应链、MCP/Tool Gateway、Approval/交付、跨进程恢复、Provider/OTel/生产配额和安全韧性证据；随后使用 E-061/E-062/E-063 的本地预生产、Pilot 和 Release Governance 控制面接入真实 OIDC、PostgreSQL/Queue、OCI/OpenBao、MCP/Model/OTel、灾备/轮换/蓝绿回退、试点团队和发布委员会，依次完成 G-036、G-037、G-038。E-055～E-063 只作为后续 Gate 前置适配，不提前推进版本发布。
- 当前工作重点：保留 M24/M25/M26/M27/M28/M29/M30/M31/M32/M33/M34 的 fail-closed 契约；员工端与治理台、M30 运营台、M31 安全运营摘要、M32 预生产门禁、M33 企业试点门禁和 M34 1.0 发布治理只消费实际 capability/API/SSE/摘要，已实现 overview、资源动作、MCP 脱敏摘要、模型/配额/遥测安全快照、Kill Switch/容量/安全事件/开发故障、发布候选/Readiness/Secret Lease/预生产事件和 promote/rollback、Pilot 旅程/观察/退出/Readiness、Publication Gate/Risk/Approval/Rollout/Revocation/Evaluation；真实 Profile/Policy/Quota 管理、Provider/OTel 对账、微 VM 攻击矩阵、Secret/OpenBao、对象存储/部署灾备、密钥轮换、蓝绿回退、7 天 `/ready=200`、四周企业试点和生产发布仍关闭。接入 OpenBao、测试 MCP 和真实出站代理前不得开放生产 MCP、OAuth、Shell/Git 写、测试/扫描或 push/PR；审批决策、实际 Tool pause/resume、submit-change、PR、合并、发布、跨进程恢复、子 Agent 执行、未知结果补偿、真实模型外发、生产配额、生产灾备、试点和发布动作必须在对应 G-030/G-031/G-032/G-034/G-035/G-036/G-037/G-038 后接入。G-033～G-038 通过前保持治理写入口、高风险执行、公有模型外发、生产配额、生产恢复、试点和发布灰度关闭；不得把 Virtual Provider、内存对象存储、PGlite、本地 HTTP Transport、本地审批适配器、LocalChildFactory、本地员工 UI、本地治理 UI、本地 Recovery Adapter、Pilot/Release Governance 本地控制面或本地 FailClosed Readiness Probe 当生产能力。
- 关键路径：M21 契约/队列 → M22 独立 Runner → M23 微 VM/网络 → M24 Workspace/Git/Artifact → M25 资源治理 → M26 MCP/Tool Gateway → M27 审批/交付 → M28 Session Tree/Sub-Agent → M29 前端/管理面 → M30 可观测/评测/配额 → M31 安全/韧性 → M32 预生产 → M33 试点 → M34 发布。
- 外部依赖：Firecracker/Kata 可用集群、Forgejo、PostgreSQL、Redis/持久队列、S3 兼容对象存储、OCI Registry、OpenBao、测试 MCP、受控出站代理、OIDC 与试点团队；凭据只通过受控配置工具录入。
- 最后更新：2026-08-20
- 关键路径：M21 契约/队列 → M22 独立 Runner → M23 微 VM/网络 → M24 Workspace/Git/Artifact → M25 资源治理 → M26 MCP/Tool Gateway → M27 审批/交付 → M28 Session Tree/Sub-Agent → M29 前端/管理面 → M30 可观测/评测/配额 → M31 安全/韧性 → M32 预生产 → M33 试点 → M34 发布。
- 外部依赖：Firecracker/Kata 可用集群、Forgejo、PostgreSQL、Redis/持久队列、S3 兼容对象存储、OCI Registry、OpenBao、受控出站代理、OIDC 与试点团队；凭据只通过受控配置工具录入。

- M21/M22 最新实现证据：E-064 已完成 lease 绑定终态写入、过期 claim/旧 lease 拒绝、detached Runner、独立 Supervisor/run heartbeat、运行前安全重排队与运行中 unknown 不重放，并在生产无 Firecracker/Kata 时让 Session 创建失败关闭；这只增强本地控制面，不改变 G-025/G-026 no-go，也不替代真实 PostgreSQL、持久 Queue、多进程 kill/restart 或微 VM 证据。
- M21/M22 真实回归补充：E-065 使用一次性 Docker PostgreSQL 和非表所有者应用角色验证 100 并发幂等、跨租户 RLS、过期 lease 接管、旧 Runner 终态写入拒绝，以及独立 bundle Runner 子进程 kill/reclaim；这只是 G-025/G-026 的部分真实证据，迁移 rollback/forward、持久 Queue、全阶段故障矩阵、interrupt/timeout/长稳、Firecracker/Kata、生产部署和回退演练仍未通过。
- M21 调度契约加固补充：E-066 增加显式 Run 状态机与 PostgreSQL 数据库 Guard，验证非法终态跳转在应用层和数据库层均失败；在干净真实 PostgreSQL 上验证 `0025` rollback/forward、非表所有者 RLS、100 并发幂等、过期 lease 接管、取消幂等、有限重试和死信。E-066 仍只是 G-025/G-026 的部分证据，持久 Queue 运维链路、全阶段强杀、interrupt/timeout/长稳、Firecracker/Kata、生产部署和正式回退演练仍未通过。
- M21/M22 故障恢复补充：E-067 在一次性 Docker PostgreSQL、非表所有者 `nexus_app`、真实独立 Runner bundle 子进程和本地 HTTP Supervisor 夹具上验证 12 个创建/运行/Tool/事件 flush 阶段的强杀、早期重排队、已创建 Sandbox 后回收并进入 unknown、事件序列连续、Manifest 唯一、无重复 Tool 事件、interrupt 和 timeout；模型/Tool 运行时使用仅限测试的 cooperative runtime，不能替代真实 Pi 模型、Firecracker/Kata、持久 Queue、drain 运维和长稳证据，G-026 仍保持 no-go。
- M22 graceful drain 与 bounded soak 补充：E-068 修正 `WorkerSupervisor` 在 abort 到达时立即调用 `beginDrain`、先发布 `draining=true` 心跳再等待活动 Run，并修正 Runner 排空规则：已启动 Runtime 或已创建 Sandbox/Workspace 资源的 Run 进入 unknown，只有资源创建前的 Run 才重排队；真实 PostgreSQL 子进程测试验证排队命令 attempts=0、已启动 Run unknown、Sandbox destroyed 和 48 次连续 Run 的一次 claim/事件连续/无孤儿 Sandbox。Windows 的 `ChildProcess.kill(SIGTERM)` 不执行 Node signal handler，故增加仅 development + cooperative runtime 的测试 shutdown sentinel；生产 SIGTERM/SIGINT 路径未放宽，24h soak、持久 Queue 和真实微 VM 仍未验证。
- M21 Queue backlog 补充：E-069 为 `PiRunStore.listBacklog` 固化服务端 tenant scope、默认未完成状态集、状态过滤、稳定排序和 1～1000 limit；InMemory 与 PostgreSQL 语义一致，真实一次性 PostgreSQL 非表所有者控制面 4 项回归通过。该增量只证明 backlog 查询控制面，不代表持久 Queue 运维、消费者排空、生产长稳或 G-025 通过。
- M21/M22 Scheduler 增量：E-070 已将 Runner 的 claim、heartbeat renew、成功 complete 和 drain admission 接入 `PiRunScheduler`；`PiRunStore` 的 release/complete/fail/deadLetter 按当前租约校验，PostgreSQL 终态在同一租户事务内提交 Run 与命令。聚焦 21 项、真实 PostgreSQL 5 项、全量 102 个文件/358 项通过、5 个文件/23 项跳过；这仍是 G-025/G-026 的部分证据，不改变 no-go，持久 Queue 运维、生产长稳、真实模型/Tool、Firecracker/Kata 和生产部署继续关闭。
- M23 Sandbox transport security 增量：E-071 已将远程 Sandbox 请求收敛为短期 HMAC Run Token；创建请求绑定 tenant/actor/session/workspace/run/provider，后续操作额外绑定 `sandboxId`，Supervisor 身份回显和恢复范围由客户端/Orchestrator 双重校验，Token 不进入 body、持久记录或模型上下文。真实非表所有者 PostgreSQL + 独立 Runner bundle + HTTP Supervisor 夹具 process 1/1、fault matrix 14/14，全量 102 个文件/359 项通过；这仍只是 G-027 的控制面与 transport 部分证据，不改变真实 Firecracker/Kata、egress proxy、攻击矩阵和生产部署 no-go。
- M23 Supervisor/Firecracker adapter 增量：E-072 已补齐独立 Supervisor HTTP/health/readiness、binding store、Linux/KVM/vsock/cgroup/rootfs/kernel/Secret preflight、Firecracker Unix API configure/start、最小环境进程、原始 limits/network policy 恢复元数据、vsock Guest Agent JSONL 客户端和无 Network Controller 时的网络 fail-closed；E-073 进一步要求恢复 PID 属于 `cgroup.procs`，并覆盖 Guest Agent CONNECT/OK、requestId 相关性和非法握手失败关闭；E-074 再增加 VMM `/proc/<pid>/exe` 身份、network policy digest/字段和 runtime/socket/cgroup 残留复验；E-075 再收紧内部 Workspace ref、Guest Agent 相对路径和文本载荷边界；E-075 聚焦 1 个文件/4 项测试，全量 106 个测试文件/373 项通过、5 个文件/23 项跳过，typecheck、Lint、37 页隔离 Next build、Runner/Supervisor bundle、Docker build/health smoke 通过。当前 Windows/WSL2 无 `/dev/kvm`，真实 Firecracker/Kata/Guest Agent rootfs、RuntimeClass/seccomp/capability、Network Controller、Forgejo/S3、攻击矩阵和 G-027/G-028 仍 no-go。

- M24 Remote Workspace/Object Storage adapter 增量：E-076 收紧 Remote Workspace endpoint 必须为无凭据/query/hash 的 HTTPS，path 拒绝 `//`、`..` 和控制字符并透传 tenant/actor/session/run，providerWorkspaceRef 只允许内部 scheme；Object Storage put 校验本地 SHA-256/size，download grant URL 只允许无凭据 HTTPS。聚焦 1 个文件/7 项测试，全量 106 个测试文件/376 项通过、5 个测试文件/23 个测试跳过，typecheck、Lint、37 页隔离 Next build、Runner/Supervisor bundle、Docker build/health smoke 通过；真实 Forgejo/S3、短期凭据、测试/扫描、URL 过期/越权和 G-028 仍 no-go。
- M24 Object Storage identity continuity 增量：E-077 修正 Remote adapter 使用 artifactId 冒充 session/run 的问题；put/download/revoke/delete 全生命周期统一携带真实 tenant/actor/session/run/trace scope，scope 只进入受控请求头，身份字段不进入对象请求体，缺少真实 Run 时失败关闭。聚焦 1 个文件/9 项测试，全量 106 个测试文件/378 项通过、5 个文件/23 个跳过，typecheck、Lint、37 页隔离 Next build、Pi Runner/Supervisor bundle 通过；真实 S3/Forgejo、短期凭据、测试/扫描、URL 过期/越权和 G-028 仍 no-go。
- M24 Git Credential/Workspace identity continuity 增量：E-078 修正 Remote Git Credential issue/revoke 使用 workspaceId 冒充 session/run、revoke 使用 system 身份以及 Workspace provider 未使用持久 Session、请求体未做字段隔离的问题；Remote Workspace/Credential 请求统一使用持久 Workspace 的真实 tenant/actor/session/run headers，所有 Workspace 请求体只含白名单业务字段，Credential 请求体不携带 actor、credentialRef 或 context，InMemory revoke 对跨租户/用户/Session/Run 失败关闭。聚焦新增 4 项回归，全量 106 个测试文件/382 项通过、5 个文件/23 个测试跳过，typecheck、Lint、37 页隔离 Next build、Pi Runner/Supervisor bundle 通过；Windows/WSL2 preflight 仍按预期 `not_ready`/退出 2，真实 Forgejo、短期凭据服务、S3、测试/扫描、URL 过期/越权和 G-028 仍 no-go。

- M24 Supervisor state/recovery 增量：E-080 新增可替换 `PiWorkspaceSupervisorStateStore`、无密钥 JSON 原子文件、启动 schema 校验、Git root/origin/实际 head 复验、对象/Grant scope 恢复、过期 lease/Grant 清理和坏状态失败关闭；真实 Docker Forgejo/MinIO + HTTPS Supervisor 重建后恢复 diff/下载 Grant，跨租户 lease mismatch 拒绝。全量 108 个测试文件/388 项通过、7 个文件/25 个测试跳过，typecheck、Lint、37 页隔离 Next build、Runner/Supervisor bundle 通过，preflight `not_ready`/退出 2。文件适配器仅覆盖单实例恢复，不覆盖 PostgreSQL/RLS、多进程并发、数据库故障或 G-028；相关写入口继续按 Gate 关闭。

- M24 Supervisor DB state 增量：E-081 新增 `0038_pi_workspace_supervisor_state.sql`、按租户分区的 PostgreSQL Supervisor state store、强制 RLS、owner lease、版本 CAS、renew/release 和 DB-backed 生产入口；PGlite 状态/RLS 元数据回归 6 项通过，真实非表所有者 PostgreSQL 1 项通过，验证租户不可见、第二 Owner 拒绝和 last-writer 冲突失败关闭。全量 109 个测试文件/391 项通过、8 个文件/26 个测试跳过，typecheck、零警告 Lint、37 页隔离 Next build、Runner/Supervisor bundle 通过，preflight `not_ready`/退出 2。该增量只完成 Supervisor 状态数据库适配，不完成真实微 VM checkout、测试/扫描、URL 攻击矩阵、六类编码旅程或 G-027/G-028；JSON 文件仍仅适用于单实例，生产 DB 状态也未宣称 G-028 通过。
- M24 六旅程增量：E-082 新增 `tests/integration/pi-vibe-coding-journeys.test.ts`，通过 `PiWorkspaceService` 对新功能、Bug 修复、重构、测试失败修复、只读 Review 和 PR 六条 virtual/local 路径验证精确 base、`pi/` 分支、Diff、Checkpoint/Artifact、Review 写入拒绝、PR 分支提交和终态清理；另验证清理失败进入 `unknown` 并停止成功声明。聚焦 7 项、全量 110 个测试文件/398 项通过、8 个文件/26 项跳过，typecheck、零警告 Lint 和 project-to-act check/validate 通过。该证据不替代真实微 VM、Forgejo/S3、测试/扫描、URL 攻击矩阵或 G-028；生产写入口继续按回退矩阵关闭。
- M22/M24 Runner 编排增量：E-083 新增 `tests/integration/pi-runner-vibe-coding.test.ts`，通过 `PiRunnerWorker` 实际串联 Workspace、Sandbox、Checkpoint 和 cooperative Runtime；固定清理先于成功终态，清理不确定时 Run/Session/Command 统一进入 `unknown` 并记录 `PI_RUN_CLEANUP_UNKNOWN`。聚焦 3 项、全量 111 个测试文件/401 项通过、8 个文件/26 个测试跳过，typecheck、Lint、Pi Runner bundle 通过。该 local/virtual 证据不替代真实 Pi 模型/Tool、持久 Queue、Firecracker/Kata、Forgejo/S3、测试/扫描或 G-026/G-028；生产 execution consumer 继续按回退矩阵关闭。
- G-027/G-028 环境前置增量：E-084 的 Sandbox preflight 在当前 Windows 返回 `not_ready`/退出 1；Docker/Compose 可用但 Linux/KVM/vhost-vsock/cgroup/provider/rootfs/kernel/HTTPS endpoint/Run Token 和真实 Forgejo/S3/扫描工具链未就绪。该 no-go 证据继续禁止宿主/普通容器降级，execute Profile、Shell/Git 写入和真实交付入口保持关闭。
- M22 Runner 错误回退增量：E-085 修复错误路径在 `finally` 中吞掉 Workspace/Sandbox cleanup 异常的问题；运行时失败后也必须先完成清理，清理不确定即进入 `unknown`，不自动重试。全量 111 个测试文件/402 项通过、8 个文件/26 个测试跳过，typecheck、Lint、Pi Runner bundle 通过；该 local/virtual 证据不改变 G-026/G-027/G-028 no-go。
- M24 测试/扫描 Artifact 增量：E-086 新增服务端解析的 `PiValidationPlan`、`PiWorkspaceValidationService` 和 Runner wiring；验证命令只能来自 approved Profile/tenant policy，命令只以 digest 进入事件，输出进入 tenant/session/run 绑定的 `test_report`/`scan_report` Artifact；已知非零退出进入 `failed/dead_lettered`，执行器异常进入 `unknown` 且不重试。Runner 聚焦 7 项、全量 111 个测试文件/405 项通过、8 个文件/26 个测试跳过，typecheck、Lint、Pi Runner bundle 通过；仍为 local/virtual/cooperative 证据，真实微 VM、Forgejo/S3、SAST/SCA、URL 越权/过期和 G-028 不变。
- M24 Artifact actor-scope retention 增量：E-087 修正 InMemory retention consumer 仅按 tenant+actor 过期，补充同租户跨员工状态不越界回归；全量 111 个测试文件/406 项通过、8 个文件/26 个测试跳过，typecheck、Lint、Pi Runner bundle 通过。该证据仍限于 local/InMemory adapter，PostgreSQL、真实对象存储 URL 过期/越权和 G-028 不变。
- M24 Supervisor Object key 与短期 Grant 生命周期增量：E-088 为 S3-compatible Supervisor 对同 scope 同内容写入提供幂等返回，拒绝跨 scope 复用和内容/元数据覆盖；本地 fake S3 HTTP 回归覆盖过期下载 Grant、跨 scope revoke 和撤销后下载拒绝。聚焦 2 项、相关 Supervisor 8 项、全量 112 个测试文件/408 项通过、8 个文件/26 个测试跳过，typecheck、Lint、Pi Runner bundle 通过；仍不替代真实 S3、URL 攻击矩阵和 G-028。
- M25 ResourceLoader Runtime binding 增量：E-089 增加受控 `PiResourceMaterializer` 合同，按 Session/Run 快照拒绝缺失、额外、重复或空制品；仅 Firecracker/Kata 允许可执行 Package/Extension，物化出的 Extension Factory 接入真实 Pi `EnterpriseResourceLoader`，cwd/agentDir 固定为 Sandbox root，Pi SDK 启动失败会清理已物化资源。聚焦资源治理 8 项、全量 113 个测试文件/412 项通过、8 个文件/26 个测试跳过，typecheck、Lint、Pi Runner bundle 通过；未实现真实 OCI/SBOM/SCA/签名服务，G-029 继续 no-go。
- M25 Guest boundary 增量：E-090 要求可执行资源除 Firecracker/Kata provider 外还必须具备显式 `executionBoundary=guest`，Runner/Runtime 双重拒绝仅有 provider 标签或 host boundary 的 Sandbox，并将 AbortSignal 传给 materializer；资源治理聚焦 9 项、全量 113 个测试文件/413 项通过、8 个文件/26 个测试跳过，typecheck、Lint、Pi Runner bundle 通过。该证据仍不替代 Guest Attestation、真实微 VM 和 G-027/G-029。
- M25 PostgreSQL 状态一致性增量：E-091 修复资源 Registry 的 partial update 语义，区分“未提供 `revoked_at`”与“明确清空”，Skill 与 Package 重新审批会清除撤销时间，rollout/scan 等局部更新不会误清除撤销状态；PGlite 两项 PostgreSQL Store 回归、全量 113 个测试文件/413 项通过、typecheck、Lint、Pi Runner bundle 通过。该证据仍不替代真实 OCI/签名/SBOM/SCA、缓存传播、Guest Attestation、微 VM 或 G-029。
- M26 Pi MCP scope 连续性增量：E-092 将 Pi 注册的 MCP Tool 调用绑定当前 Session 记录 ID 与 Runner lease 的 `runId`，Runner/Runtime 对存在 MCP Binding 但缺少 Tool Gateway 或 Run scope 的路径失败关闭，并回归审计中同时具备 tenant/actor/session/run 归属；3 个 M26 测试文件/13 项、全量 113 个测试文件/415 项通过，typecheck、Lint、Pi Runner bundle 通过。该证据仅覆盖本地 InMemory/PGlite 控制面和测试 Gateway，不替代真实 MCP、OpenBao、受控出站代理、SSRF/DNS/Metadata 攻击矩阵或 G-030。
- M26 MCP audit scope 强制增量：E-093 将 `McpInvocation`/`McpCallAudit` 的 Session/Run 改为必填，Gateway 与 Bridge 双重拒绝空 scope 或 context/session 不一致，PostgreSQL audit adapter 对无效 UUID 失败关闭，并以 `0039` 对后续审计写入增加 `session_id/run_id` 非空检查和 scope 索引；定向 3 个测试文件/13 项、全量 113 个测试文件/415 项通过，typecheck、Lint、Pi Runner bundle 通过。该证据只覆盖本地 InMemory/PGlite/测试 Gateway，不替代历史 NULL 数据治理、真实 MCP/OpenBao/出站代理或 G-030。
- M27 Change Delivery 增量：E-095 新增 `PiChangeDeliveryService`、双实现 Store、`0040` 强制 RLS 迁移、变更提交/PR/合并/发布提案 API 和 system-only Outbox dispatch；E-096 增加审批等待态的对象版本重验/CAS 激活、`pi-change-delivery` Durable Worker、`0041` Worker 角色、`0042` lease owner/token/expiry fencing，以及按租户 credentialRef 解析 Secret 的 Forgejo PR/mergeability/显式 merge Gateway；服务端重验 Workspace/Diff/Checkpoint/Test/Scan/Approval/Repository scope，外部交付默认关闭，异常和过期租约进入 `unknown` 且禁止自动重放。E-096 聚焦 5 个测试文件/20 项、全量 118 个测试文件/435 项通过，8 个文件/26 个测试跳过，typecheck、Lint、隔离 Next 生产构建和 Pi Runner bundle 通过。真实 Forgejo、组织审批、OpenBao、受控出站、实际 pause-resume、持久外部交付和合并发布及 G-027/G-030/G-031 仍 no-go。

## 按需读取索引

| 当前任务 | 追加读取 |
|---|---|
| 产品与企业管理 | `docs/01-product-blueprint.md`、`docs/02-enterprise-management-model.md` |
| 领域与架构 | `docs/03-domain-and-data-model.md`、`docs/04-technical-architecture.md` |
| Agent | `docs/05-agent-platform.md` |
| 三平台连接 | `docs/06-channel-integrations.md` |
| 权限安全 | `docs/07-security-and-permissions.md` |
| API/事件 | `docs/08-api-and-event-contracts.md` |
| 测试验收 | `docs/09-testing-and-acceptance.md` |
| 交付顺序 | `docs/10-delivery-roadmap.md` |

## 路线变更记录

- D-040 · 2026-08-26：M35/F-076 的测试阶段新增 `agentops-awesome-list` 推荐，用于在功能测试完成后、交付前按实际复杂度执行只读健康检查，识别架构缺口、功能风险与优化建议。该 Skill 仅提供诊断和改进建议，不修改项目、不授予权限、不替代 `aawo-agent-tester` 功能测试或既有交付门禁。确认来源：当前用户补充指令。

- D-039 · 2026-08-26：新增 M35/F-076“Agent 开发”团队工作流模块。需求交接必须由服务端转化为 `project-to-act` 五类文档并完成租户内归档，归档成功前不得登记开发版本；每个主要版本必须保留完整 Diff 内容摘要、服务端 SHA-256 和功能清单，每个版本必须绑定至少一项通过的功能测试后才允许生成交付清单；最终交付冻结最新五文档、全部主要版本与功能测试摘要。工作流按阶段建议 `project-to-act`、`repo-task-sync`、`llm-api-config`、`ui-design`、`aawo-agent-tester` 和 `avoid-overkill`，但 Skill 建议不授予权限或绕过门禁。确认来源：当前用户指令。

- D-026 · 2026-08-20：冻结 PI-MOD-03 的调度边界：`PiRunScheduler` 是 Runner 面向 Queue 的 admission/control facade，负责本地 claim barrier、lease renew、release 和成功/失败终态入口；`PiRunStore` 负责租户 RLS、当前 owner/token/run/expiry 的 CAS 以及 PostgreSQL 事务。`complete/fail/deadLetter` 必须在同一租户事务中提交 Run 状态与命令终态，旧/过期租约返回 false；`beginDrain` 后本地 Scheduler 不暴露新 claim，Web/API 不新增执行路径。原因：把调度策略、Runner 生命周期和存储原子边界分离，避免 Worker 直接绕过 Queue 控制面；确认来源：E-070 聚焦与真实 PostgreSQL 竞争 Scheduler 回归。
- D-027 · 2026-08-20：冻结 PI-INT-005 的 Sandbox transport 边界：创建请求使用绑定 tenant/actor/session/workspace/run/provider 的短期 HMAC Token，创建成功后每个操作请求重新签发并额外绑定 `sandboxId`；Token 只进入 `Authorization` 头，不进入请求体、RunManifest、Sandbox 持久记录、日志或模型上下文。Remote Client 必须校验 Supervisor 返回的身份回显，Orchestrator 在创建、调用、恢复、销毁前再次复验；缺少托管 Secret、Token scope/签名/TTL 失败或身份不一致时 fail-closed。原因：即使同一 Run 的元数据被错误复用，也不能把操作 Token 拿到另一沙盒；确认来源：E-071 单元、真实 PostgreSQL/独立 Runner 进程和 HTTP Supervisor 夹具回归。该决策不把夹具当作真实 Firecracker/Kata、egress proxy 或 G-027 通过证据。
- D-028 · 2026-08-20：冻结 PI-MOD-05 的 Supervisor/backend 边界：Web/API 不启动 Firecracker；独立 Supervisor 只通过 Unix API Socket 和最小环境进程配置 Firecracker，rootfs 只读、Guest Agent 只走 vsock、CPU/内存/PID 由 cgroup v2 绑定，运行元数据不含 Token/Secret，恢复必须校验 PID/Socket/cgroup/limits/network policy；默认无 Network Controller 只能运行 `none` 网络，任何微 VM 前置或恢复证据缺失均 `/ready=503`/失败关闭。E-072 的 fake transport/process/Guest Agent 只证明适配合同和生命周期清理，不替代 G-027 的真实节点、seccomp/capability、网络攻击矩阵和 10,000 次残留检测。
- D-029 · 2026-08-20：冻结 PI-MOD-05 的恢复身份证明：`cgroupController.open` 必须携带持久化 VMM PID，并在恢复前验证该 PID 出现在目标 `cgroup.procs`；缺少成员证明时不得重新应用 limits、恢复 Guest Agent 或清理资源。Guest Agent 的 loopback 连接工厂只用于协议测试，不能作为生产 vsock 实现或 G-027 证据。确认来源：E-073 cgroup/协议回归。
- D-030 · 2026-08-20：冻结 PI-MOD-05 的运行元数据/残留验证边界：恢复必须校验记录 PID 的 `/proc/<pid>/exe` 与配置 runtime 的 realpath 一致，并重新编译校验 network policy digest、字段和 limits；销毁验证必须同时确认 runtime directory、vsock/API socket directory 和 cgroup directory 消失，缺少任何一项证明即返回未销毁。确认来源：E-074 recovery metadata/residual hardening 回归；该规则不替代真实微 VM 的攻击和 10,000 次残留 Gate。
- D-031 · 2026-08-20：冻结 PI-MOD-05/PI-INT-005 的 Workspace mount 与 Guest Agent 输入边界：`sourceRef` 只允许 `workspace://`、`virtual://`、`forgejo://` 三类内部 opaque ref，不接受 `file/http/https/s3` 等可诱导外部读取的 URI；Guest Agent 文件操作只接受相对路径，拒绝反斜杠、`..` 和超过 1.5 MB 的单段文本。原因：Supervisor 不得把任意 URI 或 host-side path 意义传入 Guest Agent；确认来源：E-075 mount/path/payload 回归。该规则不替代 Guest Agent rootfs 内部权限、微 VM 网络和 Forgejo/S3 G-027/G-028 验收。
- D-032 · 2026-08-20：冻结 PI-MOD-06/PI-MOD-15/PI-INT-012 的远程适配器输入输出边界：Provider endpoint 必须为无凭据/query/hash 的 HTTPS；请求 path 拒绝 `//`、`..` 和控制字符，并透传服务端计算的 tenant/actor/session/run 身份；远程 workspace ref 与 storage ref 只允许内部 scheme；对象上传必须由服务端比对本地 SHA-256/size，下载授权只允许无凭据 HTTPS URL。原因：Remote Adapter 不得扩大请求目标、伪造身份或把远端返回的任意 URL/ref 变成跨租户读取能力；确认来源：E-076 adapter boundary 回归。该规则不替代真实 Forgejo/S3、URL 过期/越权、短期凭据和 G-028 验收。
- D-033 · 2026-08-20：冻结 PI-MOD-15/PI-INT-012 的对象存储身份连续性：put/download/revoke/delete 必须使用服务端真实 tenant/actor/session/run/trace scope，身份只通过受控请求头透传，不能由 artifactId 推导或进入请求体；没有真实 Run 的 Artifact 不得进入 Remote Object Storage，必须失败关闭。原因：防止对象服务把伪造的 artifact/session 视为合法执行主体，并保证审计链能回到真实 Run；确认来源：E-077 identity continuity 回归。该规则不替代真实 S3/Forgejo、凭据轮换、URL 过期/越权和 G-028 验收。
- D-034 · 2026-08-20：冻结 PI-MOD-06/PI-INT-011 的 Git Credential/Workspace 身份连续性：Remote issue/revoke 和所有 Workspace provider 请求必须使用持久 Workspace 的真实 tenant/actor/session/run scope；Credential 请求体只允许服务端所需 repository/workspace/branch/TTL 字段，禁止 actor、credentialRef、context 和 system 伪造身份；InMemory/Remote revoke 必须校验同一租户、用户、Session、Run。原因：防止 workspaceId 或 system scope 被当作执行主体，确保 Credential lease 的审计和撤销可回到真实 Pi Run；确认来源：E-078 identity continuity 回归。该规则不替代真实 Forgejo、短期凭据服务、凭据轮换和 G-028 验收。
- D-035 · 2026-08-20：冻结 PI-MOD-06/PI-MOD-15/PI-INT-011～012 的 Supervisor 运行边界：Workspace Supervisor 独立于 Web/API，HTTPS HTTP contract 只从受控 headers 解析身份，Git credential 只在服务端进程环境中以临时 extraHeader 使用，S3 对象通过服务端摘要和短期 opaque Grant 访问；scope-bound workspace 的 cleanup 不因已撤销/已过期 lease 阻塞，但已知 lease 的 tenant/actor/session/run/repository/workspace/branch 不一致必须拒绝。原因：把 Git/S3 外部系统连接、凭据注入、清理和多租户 scope 复验集中在独立适配边界，便于回退和审计；确认来源：E-079 Docker Forgejo/MinIO + HTTPS Supervisor 真实回归。该规则不把 Supervisor E2E 当作 Firecracker/Kata 隔离、测试/扫描或 G-027/G-028 通过证据。

- D-036 · 2026-08-20：冻结 PI-MOD-06/PI-MOD-15 的 Supervisor 状态恢复边界：状态存储必须通过可替换接口，默认持久实现只序列化显式 workspace/lease/object/grant 元数据，禁止 token/secret/password/authorization/private key；启动恢复必须验证 schema、scope、Git workspace root/origin/实际 head、storage ref 和 Grant TTL，无法证明则丢弃失效资源或失败关闭；当前 JSON 文件只作为单实例恢复适配器，生产多进程必须改用 PostgreSQL/RLS/事务 store，不得将共享文件的 last-writer 结果当企业事实。原因：避免 restart 恢复把错误目录、过期授权或凭据写回服务，并为后续数据库状态 store 保留接口边界；确认来源：E-080 单测与真实 Forgejo/MinIO + HTTPS 重建回归。

- D-037 · 2026-08-20：冻结 PI-MOD-06 Supervisor 多进程状态边界：`pi_workspace_supervisor_states` 按 `state_id + tenant_id` 分行，强制 RLS 只允许当前 `app.tenant_id`，状态 payload 必须按租户切片且只含显式 workspace/lease/object/grant 元数据；服务实例通过 owner lease fencing，写入使用 loaded version CAS，renew/release 由 Supervisor 生命周期驱动，冲突或 owner 丢失必须失败关闭。PGlite 只验证迁移元数据和分区，真实非表所有者 PostgreSQL 才作为 RLS 可见性证据；共享 JSON 文件不得进入多进程生产。确认来源：E-081 PGlite 与真实 PostgreSQL 回归。
- D-038 · 2026-08-20：冻结 PI-MOD-13 的审批人目录边界：首版 `PiApprovalApproverDirectory` 从当前租户权威授权事实源解析 `users → user_roles → roles → role_permissions → permissions`，只返回 active 用户、有效期内角色授权且匹配当前 R2/R3 permission 的主体，始终排除请求人；数据库、授权源或数据完整性不可用时失败关闭，不用静态列表或客户端提交的 approver ID 降级。该接口保留未来接入显式组织审批组/项目范围目录的替换点，当前不新增第二套权限事实源。确认来源：M27 W27-08 实施前审计；待 E-098 验证。

- D-021 · 2026-08-19：用户要求把 Pi 企业统一开发平台的预期实现完全按 project-to-act 重新拆解，细化到模块、接口、函数、阶段 Gate 与回退，并要求后续严格依照项目文件执行且本批只修改项目文件。影响：保留 F-053/M20/A-019/G-023 作为已有纵向切片历史，新增 M20.2、M21～M34、F-054～F-075、PI-MOD/PI-API/PI-INT/PI-EVT 契约、分阶段验收与回退矩阵；`.project-to-act/` 五份文档成为后续实现的唯一管理事实源。本次不修改源码、配置、依赖或部署制品。确认来源：当前用户指令。

- D-022 · 2026-08-20：为执行 F-075 而不把真实试点或正式发布误判为完成，将 M33/M34 的工作包细化为本地可验证的 Pilot Governance 与 Release Governance 控制面。M33 增加试点项目/成员、六类旅程账本、质量/成本/安全/采纳/稳定性观察、抽检、事故和退出；M34 增加发布候选、Gate Attestation、风险清单、双人签字、灰度/扩容/回退、撤销、Pi upstream 兼容和持续评测门禁。新增 PI-MOD-25～26、PI-API-072～084、PI-INT-024～028、PI-EVT-056～065、`0035_pi_pilot_control.sql`、`0036_pi_release_governance.sql`、E-062/E-063 证据目标；默认探针和发布门禁失败关闭，真实 G-037/G-038 仍必须依赖 G-036、试点团队、签名制品、外部运行和发布委员会，不能以本地控制面替代。确认来源：M33/M34 既有工作包与当前完整实现目标。

- D-023 · 2026-08-20：M22 故障恢复采用“一次 Run 至多一个 Sandbox”的幂等边界：在 Sandbox 资源句柄已经持久化后发生 Runner 崩溃，即使回收成功也将 Run 标记为 `unknown`，不自动重放；只有在 Sandbox 记录尚未产生、尚无外部资源句柄的 claim 早期崩溃才允许有限重排队。原因是恢复逻辑不能假定外部 Sandbox 创建/销毁具有事务性，必须优先避免重复资源和重复副作用；回收不可验证时继续保持 `unknown` 并转人工核对。E-067 验证该语义，G-026 仍需真实 Sandbox/Queue/long-soak 证据。

- D-024 · 2026-08-20：M22 graceful drain 将“停止新 claim”和“等待活动 Run”拆成两个阶段。`beginDrain` 在 abort 事件同步设置 Runner claim barrier 并中止活动 Runtime，Supervisor 随即写入 `draining=true` heartbeat；完成路径再等待 in-flight Run 并关闭数据库。为跨平台测试增加 `NEXUS_PI_TEST_SHUTDOWN_FILE`，仅在 development + cooperative test runtime 下启用，不成为生产控制面；排空后的副作用未知结果保持 `unknown`，禁止因进程优雅退出而自动重放。确认来源：E-068 实现与真实 PostgreSQL drain/soak 回归。

- D-025 · 2026-08-20：冻结 M21 backlog 查询语义：`PiRunStore.listBacklog` 只接受服务端传入的 tenant scope，不开放 HTTP 客户端自报租户；默认只返回 `accepted/queued/leased/cancel_requested`，显式状态集合去重，`limit` 默认 100、范围 1～1000，按 `available_at/created_at/id` 稳定排序；InMemory 与 PostgreSQL 必须保持同一语义，PostgreSQL 通过 `withTenant` 和 tenant predicate 双重约束。原因：Queue 运维读取是跨租户高风险控制面，必须先冻结可审计的最小查询合同；acknowledged/dead-letter/unknown 不应被默认 backlog 误报为待处理。确认来源：E-069 聚焦与真实 PostgreSQL 非表所有者回归。

- D-020 · 2026-08-18：根据用户要求将 Pi Agent 作为统一 Vibe Coding 底层 Runtime。影响：新增 M20/F-053；Pi SDK 仅通过受控 ResourceLoader、Profile、Custom Tool 和 ModelRuntime 接入，Session/事件/检查点进入租户隔离存储，默认虚拟沙盒只用于开发测试，生产未接入 Firecracker/Kata 前必须失败关闭；新增 `0024_pi_enterprise_runtime.sql`、Pi Session API、SSE、Kubernetes Runner 隔离模板和安全验收 Gate。确认来源：当前用户“PLEASE IMPLEMENT THIS PLAN”。

- D-019 · 2026-08-17：根据上线前 T4 审查结果并经用户授权开始实施，新增 M19/F-052/E-045。影响：敏感值在输入、自动记忆与模型出站三处失败关闭，受限记忆不可回注模型；任务交接使用 Artifact/不可变版本/SHA-256/数据分级冻结快照，并允许已签收交付物在后续交接链继承；主 Agent 仅呈现当前权限可用 Tool 对应的 Skill，最终输出采用受验证 JSON 合同，路由记录仅由实际 Tool 调用生成。新增 `0023_work_artifact_evidence_chain.sql`、交付物 API、迁移 readiness 与不含业务内容的 Agent/记忆遥测。二进制文件下载仍须接入受控对象存储授权层；真实 IdP、生产 PostgreSQL、企业通道和试点不因本地 Gate 而豁免。确认来源：当前用户“开始实施”。

- D-018 · 2026-08-17：用户要求补齐缺失部分，尤其完善分级记忆和持久化。影响：新增 M18/F-051、`0022_agent_memory.sql`、对话/上下文/长期/任务/情景五层记忆、显式长期记忆确认、RLS/原子审计/过期版本控制、`memory.recall` 与 `memory.remember` Tool、记忆 API，并将主对话的可见任务/交接与会话情景自动写入及按权限回注。新增统一办公只读 Tool 覆盖治理、经营、知识、会议与流程；所有 Tool 仍由模型依据声明式 Skill 选择，确定性代码只负责权限、作用域、审计、状态与确认门禁。确认来源：当前用户指令。

- D-017 · 2026-08-16：用户要求企业微信应用凭据不再放入通用 `.env.local`，以便后续其他 AI/平台独立接入。影响：新增根目录 `.env.wecom.local` 与可提交模板 `.env.wecom.example`；当专用文件存在时，CorpID、App Secret、AgentId 只从该文件读取且不回退同名通用环境变量；令牌交换、应用消息、应用控制、验收探测、管理通知和 readiness 统一使用同一配置源。生产未挂载专用文件时仍允许部署 Secret 平台注入。确认来源：当前用户指令。

- D-016 · 2026-08-14：用户纠正企业微信接入路线：管理后台只负责创建应用、可见范围与凭据初始化，AI 日常发送必须直接调用自建应用 API。影响：新增 M17/F-049、`wecom-application-messaging` Skill、`wecom.send_application_message` R3 Tool、服务端唯一姓名解析、`message/send` 网关和 `0021` 权限迁移；成员 UserID、应用 Secret、access_token 与平台原始回执不得进入模型上下文。出站消息与 DNS/回调解耦，但真实测试必须在凭据存在时获得平台回执；当前凭据缺失，向“王渊芃”未发送。确认来源：当前用户纠正与测试指令。

- D-012 · 2026-08-12：用户提供生产根域名 `vastmind.com.cn` 并授权开始企业微信真实配置。办公平台固定使用独立子域名 `office.vastmind.com.cn`，避免占用现有 `www` 官网；真实接入同时保留企业微信自建应用（身份、OAuth、主动通知和受控动作）并新增智能机器人 API 模式作为 AI 单聊/群聊入口。公网预检发现裸域名无 A/AAAA、`www` 指向 `82.157.0.21` 但 80/443 直连超时、`office` 尚无记录，因此外部 Gate 先进入 DNS/HTTPS 恢复，再执行后台回调和真实 E2E。确认来源：当前用户指令；配置清单见 `docs/19-vastmind-wecom-rollout.md`。
- D-013 · 2026-08-12：用户要求把正式任务发放和消息推送明确分开。正式任务必须发送给已验证的目标个人或目标部门，经过严格鉴权、范围校验、人工确认和任务状态/证据门禁；沟通推送仅由 LLM 理解后放入对应的公司或部门消息池，可见成员可以反馈，不产生任务责任、期限、验收或业务状态。影响：新增 M14/F-046、`0018_work_message_pools.sql`、两个声明式沟通 Tool 和独立消息事件流；不得用关键词或固定程序替代模型决定两条路线。确认来源：当前用户指令。
- D-015 · 2026-08-14：用户要求开始接入 AI，先打通企业微信接口并用于管理系统控制权限。影响：新增 M16/F-048、`wecom-access-control` Skill、只读权限面 Tool、R3 应用配置 Tool、管理系统只读 API 和 `0020` 权限目录迁移；按企业微信官方边界，不把普通自建应用包装成万能权限接口，可见范围转管理后台、通讯录写入要求独立同步凭据、敏感字段要求用户 OAuth、内部角色继续独立审批。模型不得接触 Secret/token，企业微信聊天渠道不得发起管理变更。确认来源：当前用户指令。
- D-014 · 2026-08-12：用户要求正式任务支持多成员连续交接，并保证责任、任务内容和各类文件信息在传递中可持续查询、链路不中断。影响：新增 M15/F-047、`0019_work_task_handoffs.sql`、冻结资料快照、接收人签收/退回、交接期间状态冻结、RLS/审计和三个声明式交接 Tool；不得用固定程序替代模型对交接、查询或沟通意图的理解。确认来源：当前用户指令。
- D-011 · 2026-08-12：用户纠正统一大前端的产品表达。主对话必须作为审批、项目、会议、知识、经营、组织和任务等全部企业办公意图的统一入口，任务管理仅因高频而保留轻量侧栏；首页禁止大标题、显式路由流程和任务指挥大屏式表达，要求尽可能极简，复杂度进入后续功能模块页面。影响：重新打开 F-044 与 M13 界面验收，暂停 `0.14.0` 发布候选状态；Agent 原生 Skill/Tool 路由、权限、安全、任务 API 和持久事件能力不变。确认来源：当前用户指令。
- D-010 · 2026-08-11：用户确认最终产品形态必须以“主对话框 + 实时任务发布栏”为中心。新增 M13/F-040～F-044 与 `0.14.0-work-command-center`：主对话成为默认入口，Agent 通过模型原生 Tool Calling 和声明式 Skill 指令自主路由；任务可由对话实时拆包后定向分派或公开承接，个人可持续观察状态与证据。禁止用 Python、关键词或固定 if/else 选择业务意图；确定性代码只负责权限、安全、状态机和工具执行。该变更不豁免 R3/R4 确认、真实企业微信、IdP、灾备和试点 Gate。确认来源：当前用户指令。
- D-009 · 2026-08-05：用户确认先基于网页端和企业微信实现新增企业管理能力。新增 M12/F-034～F-039 与 `0.13.0-management-intelligence`，范围包括管理节奏、指标语义、项目组合情景、企业事项、AI 质量治理和企业微信管理动作；网页为完整控制面，企业微信为轻量处置面，两端共享同一事实、权限和审计。该变更将 `1.0.0-pilot` 外部 Gate 顺延到 M12 本地 Gate 之后，但不豁免真实企业微信、IdP、灾备和试点。确认来源：当前用户指令。
- D-008 · 2026-08-05：用户以“按这个方向”确认管理证据工作台。生产 UI 统一采用真实认证工作区与权限过滤的事实源，首页按目标—风险—决策—行动—证据呈现管理闭环，任何无数据、加载、失败、开发 Fixture 与 Agent 异步状态必须显式表达。`DR-010`、E-028 与 G-013 随最终自动化、浏览器和最新三镜像旅程通过而关闭；下一阶段恢复 `1.0.0-pilot` 外部企业 Gate。确认来源：当前用户指令。
- D-007 · 2026-08-05：T4 完整架构审计纠正“环境/表结构/测试编号存在即能力完成”的判定。重新打开 F-018 和 F-020，新增 M11/F-033，先交付持久 Worker、真实业务消费、生产事实工作台和行为型发布 Gate，再进入外部企业试点。原因：Webhook 当前只写 Inbox，InboundPipeline/卡片确认处理器未接生产运行时，Outbox 无 Dispatcher，Agent 工具在确认 HTTP 内同步执行，生产 UI 仍含演示事实，readiness/需求追踪存在假阳性。确认来源：当前用户持续完整开发目标；证据将在 E-027/E-028 形成。
- D-006 · 2026-08-05：新增 M10 企业接入验收控制面，把真实 OIDC/三平台预检、外部企业绑定、追加式证据、两阶段测试通知确认与未知结果停止重试统一为上线前置。原因：环境变量存在、HTTP 200 或按钮提示均不能代替企业级验收。证据 E-025、E-026；外部 Gate 不变。
- D-005 · 2026-08-05：新增 M9 企业管理控制面，生产请求不再信任会话内陈旧授权，而是按请求从权威源重算用户、角色、权限和数据范围；组织异动、目标驱动立项、项目基线、管理关注、结项 Gate、决定替代和补偿统一进入可审批、可审计、可回滚闭环。证据 E-023、E-024；真实企业发布 Gate 不变。
- D-004 · 2026-08-05：M8 采用统一 BFF 上的安装型 PWA 作为首个自建客户端，并把设备信任、最低版本、通知、加密离线草稿和撤销清理纳入统一策略；同时以数据库原子触发器和不可改写 RLS 策略完成全表审计闭环。证据 E-021、E-022；本地工程 Gate 通过不等同于真实企业发布。
- D-002 · 2026-08-05：由“可交互 MVP 后再选择单一集成”调整为“文档先行，完整开发网页 + 飞书 + 钉钉 + 企业微信，后续自建客户端”；原因是用户明确确认完整范围与交付顺序。影响：项目从原型转为 T3 长期工程，必须先完成 M0 设计 Gate，再按 M1～M8 实施。证据 E-006、E-007；确认来源：当前用户目标。
- D-003 · 2026-08-05：将 M7 分成“本地生产工程 Gate”和“真实企业发布 Gate”。前者允许在无外部凭据时验证 OIDC 协议、配置门禁、Secret broker、容器、性能和加密恢复内核；后者不得在真实 IdP、数据库灾备、三平台企业和试点缺失时宣称通过。证据 E-019、E-020。
- D-001 · 2026-08-05：首版采用“可交互前端 + 服务端真实模型接口 + 演示数据”的纵向切片；该版本现仅作为视觉概念验证。证据 E-001 至 E-005。
