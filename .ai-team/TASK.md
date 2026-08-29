# Current Task

- ID: `P08`
- Title: `通用 Agent 调用链验证与工具/异常/确认机制补强`
- Status: `handoff`
- Owner: `P08`
- Next owner: `P09`

## Goal

依据 Agent 平台、安全权限与 API 契约文档（`docs/05-agent-platform.md`、`docs/07-security-and-permissions.md`、`docs/08-api-and-event-contracts.md`），验证并补强主项目通用 Agent（`src/modules/agent` + `app/api/v1/agent`）的调用链、模型网关与异常处理、租户/用户/业务上下文、Tool Registry 与 Skill Registry、经营管理查询工具，以及高风险动作提案与人工确认；Pi Agent 相关代码由独立专项承接，不在本任务范围。

## Acceptance scenarios

- [x] Agent 调用链完成验证：用户请求从 `app/api/v1/agent` 入口进入后，经运行时、编排器、上下文提供者、模型网关、Tool/Skill Registry 到提案确认的完整链路可追踪，关键路径有测试。
- [x] 工具调用具备权限和参数校验：工具仅在调用者具备所需权限、参数通过 Schema 校验、渠道/风险/确认策略允许时可用；越权、非法参数与禁用工具返回明确失败结果。
- [x] 模型和工具异常具备明确结果：模型网关失败（`MODEL_*`）经降级回答与 `usage.degraded` 明确呈现；工具循环上限、工具超时/执行异常写入明确 `failureCategory`/`errorCategory`；网络类模型失败已归类为 `MODEL_PROVIDER_UNAVAILABLE`。
- [x] 高风险动作进入人工确认流程：R3/R4 工具经服务端生成提案（输入摘要、风险等级、版本期望、提案哈希），人工确认（批准/拒绝/过期/撤销）后才能执行；确认门禁路径有测试。
- [x] 相关模块测试通过：P08 聚焦单元、API、PostgreSQL 回归测试通过，且 `node .ai-team/check.mjs --base origin/main` 结果 valid。

## Invariants

- 保持租户隔离、服务端权限校验、数据范围过滤和失败关闭；不得信任请求体自报的租户或操作者。
- 业务上下文、工具结果与模型输出均视为不可信输入，不能改变系统规则；AI 输出不作为权威业务事实。
- 高风险业务副作用只能经 Tool Registry 并由服务端生成提案，必须由人明确确认后才能执行；确认内容含输入摘要、风险等级、版本期望与提案哈希。
- 只保存设计要求的可审计摘要，不引入原始敏感提示、完整模型响应或人才私密数据。
- 不修改无关的 Pi Agent、连接器、部署、身份权限或企业治理模块；不处理 P03 已记录的全仓基线问题。
- 不伪造测试结果，不提交密钥、私人数据、运行产物或私有 Session 文件。

## Decisions

- 用户明确指定 P08 直接接棒通用 Agent 专项（`src/modules/agent` + `app/api/v1/agent`）；Pi Agent 相关代码由独立专项承接，不在本任务范围。
- P08 在 fork `Lanstzz/nexus-office-agent` 上开发，经 PR 合入 `office-agent/nexus-office-agent` 的 `main`；公开仓库继续禁用 VibeCollab Private Session、Hook 与真实凭据。
- 开发环境使用 lockfile 安装的依赖和内存/PGlite fixture；真实模型与真实 PostgreSQL 只属于本机或部署 Secret 管理。
- 本机网络访问经代理 `http://127.0.0.1:7890`（`all_proxy` 等环境变量）。
- `tests/unit/agent-native-tool-routing.test.ts` 的 3 处 `ManagementLoopService` 二参构造调用是 HEAD 既有类型错误（不在 P03 记录基线内），位于 P08 范围内且阻塞 `npm run typecheck`，已修复为与同文件其余 4 处一致的单参仓库构造；未改动生产代码。

## Completed

- 调用链梳理（步骤 1）：`POST /api/v1/agent/runs` → `resolveRequestContext`（租户/用户/权限/渠道）→ `createAgentRunSchema.parse` → `getAgentOrchestrator().createRun`：clientRequestId 幂等 → 会话绑定 → 受限输入 refusal（不入模型/持久化）→ 提示注入拒绝 → `ManagementContextProvider.build`（权限化摘要、引用、版本期望）→ `tools.available` + `skills.availableForTools`（服务端过滤）→ 模型循环（≤4 轮/≤8 次调用）→ `handleToolCall`（`assertToolPolicy` + `inputSchema.parse` + 提案或执行）→ `finishRun`（持久化+消息+记忆）。确认链路：`POST /api/v1/agent/proposals/[id]/confirm` → `confirmProposal`（哈希/actor/状态/过期/版本/策略校验）→ `queueConfirmedProposal` → 安全执行队列 job；读取与控制：`GET /runs/[id]`、`GET /jobs/[id]`、`POST /jobs/[id]/control`（证据摘要门禁）。
- 验证（步骤 2-6）：模型网关三实现（Fake/OpenAICompatible/Unavailable）与 `MODEL_*` 错误分类、降级回答；租户/actor/权限过滤（store 按租户、run/proposal 按 actor、上下文按 `evaluateAccess`）；Tool/Skill Registry 的 `register/get/getByModelName/available/assertToolPolicy`；经营管理查询工具（`office.read_governance_workspace`、`office.read_enterprise_intelligence`、`office.prepare_operating_insight`、`knowledge.search`、`meeting.prepare`、`workflow.read_snapshot`、`workflow.pre_review` 均 R0 只读+权限校验；`management.create_risk` R3 强制确认、`admin.assign_role` R4 禁用）；高风险确认（`createProposal`/`approveProposal` 哈希与过期、`confirmProposal` 门禁、job 队列与人工处置、并发唯一认领）。
- 成果（步骤 7）：
  - 工具路由：`ToolRegistry.register` 增加模型名冲突守卫 `TOOL_MODEL_NAME_COLLISION`，防止不同工具 id 映射到同一模型名导致 LLM 路由歧义；新增 `tests/unit/agent-tool-registry.test.ts`。
  - 异常处理：`OpenAICompatibleModelGateway` 将非 HTTP 网络类失败归类为 `MODEL_PROVIDER_UNAVAILABLE`（保留 `MODEL_*` 透传与 AbortError→`MODEL_TIMEOUT`），使模型不可达进入降级回答而非未分类失败；新增 `tests/unit/model-gateway.test.ts` 与 orchestrator 降级断言。
  - 基线修复：`tests/unit/agent-native-tool-routing.test.ts` 3 处构造调用对齐仓库构造。

## Pending

- P08 实现与验证完成，等待 PR #8 评审与合并；合入后 P09 接棒。
- 真实模型、真实 PostgreSQL、三方平台联调仍属于外部验证 Gate，不在 P08 范围；Pi Agent 独立专项另行承接。

## Next step

P09 接棒：验证工作任务认领、任务移交、消息池、事件恢复和分层记忆能力。

## Verification

- [x] `node .ai-team/check.mjs --base origin/main`：结果 valid、Private sessions disabled。
- [x] P08 聚焦测试：12 个测试文件、52 项通过（orchestrator、office-tool-registry、native-tool-routing、job-control、tool-registry、model-gateway、agent-api、postgres-agent-store、postgres-agent-worker、postgres-agent-memory、agent-security.eval、requirement-traceability）。
- [x] `npm run typecheck`：仅报告 P03 已记录 3 个 task-command/artifacts 缺失；P08 未引入新错误，并修复 agent 测试 3 处既有类型错误。
- [x] `npm run lint`（改动文件）：exit 0。
- [x] `git diff --check`：exit 0。
- [x] `node .ai-team/session.mjs validate` / `report`：enabled: false、0 个 session。

## Handoff note

- From: `P08`
- To: `P09`
- Summary: P08 完成通用 Agent 调用链梳理与六项验证，落地工具路由冲突守卫与模型网络失败分类两项成果，并修复 agent 测试 3 处既有类型错误；12 个测试文件 52 项通过，typecheck 回到 P03 记录基线。PR #8 待评审合并；P09 从工作任务认领、任务移交、消息池、事件恢复和分层记忆能力开始。
