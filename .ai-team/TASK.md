# Current Task

- ID: `P08`
- Title: `通用 Agent 调用链验证与工具/异常/确认机制补强`
- Status: `active`
- Owner: `P08`
- Next owner: `unassigned`

## Goal

依据 Agent 平台、安全权限与 API 契约文档（`docs/05-agent-platform.md`、`docs/07-security-and-permissions.md`、`docs/08-api-and-event-contracts.md`），验证并补强主项目通用 Agent（`src/modules/agent` + `app/api/v1/agent`）的调用链、模型网关与异常处理、租户/用户/业务上下文、Tool Registry 与 Skill Registry、经营管理查询工具，以及高风险动作提案与人工确认；Pi Agent 相关代码由独立专项承接，不在本任务范围。

## Acceptance scenarios

- [ ] Agent 调用链完成验证：用户请求从 `app/api/v1/agent` 入口进入后，经运行时、编排器、上下文提供者、模型网关、Tool/Skill Registry 到提案确认的完整链路可追踪，关键路径有测试。
- [ ] 工具调用具备权限和参数校验：工具仅在调用者具备所需权限、参数通过 Schema 校验、渠道/风险/确认策略允许时可用；越权、非法参数与禁用工具返回明确失败结果。
- [ ] 模型和工具异常具备明确结果：模型网关失败（`MODEL_*`）、工具循环上限、工具超时/幂等/执行异常均写入 AgentRun 的明确 `failureCategory`，并向用户返回可核验结果。
- [ ] 高风险动作进入人工确认流程：R3/R4 工具经服务端生成提案（输入摘要、风险等级、版本期望、提案哈希），人工确认（批准/拒绝/过期/撤销）后才能执行；确认门禁路径有测试。
- [ ] 相关模块测试通过：`src/modules/agent` 与 `app/api/v1/agent` 聚焦单元、API、PostgreSQL 回归测试通过，且 `node .ai-team/check.mjs --base origin/main` 结果 valid。

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

## Completed

- 已创建 fork `Lanstzz/nexus-office-agent`，本地 remote `fork` 指向该仓库；上一轮工具刷新分支已推送并开 PR #7。
- 已按 repo-task-sync 协议开启项目：读取 AGENTS.md、PROJECT.md、TASK.md、SKILL.md；确认本地 `main` 与 `origin/main` 一致（`4c3216c`）。
- 已创建 P08 分支 `codex/p08-common-agent` 并完成本 TASK.md 的 P08 定义（当前提交）。
- 已盘点 `src/modules/agent`（domain: `tool`/`skill`/`model-gateway`/`proposal`/`agent-run`；application: `orchestrator`/`context-provider`/`management-tools`/`office-read-tools`/`store`/`schemas`；infrastructure: `postgres-agent-store`）与 `app/api/v1/agent`（`runs`、`runs/[id]`、`proposals/[id]/confirm`、`jobs/[id]`、`jobs/[id]/control`）现状及既有测试清单。

## Pending

- P08 实现尚未开始；本提交仅完成项目开启与任务定义。
- 全仓 typecheck/lint/test 基线沿用 P03/P06 已记录的范围外阻塞口径，P08 聚焦测试以实际执行为准。

## Next step

P08 第一步：梳理用户请求进入 Agent 后的调用链。从 `app/api/v1/agent/runs/route.ts` 与 `src/modules/agent/runtime.ts` 入口出发，追踪到 `application/orchestrator.ts`、`context-provider.ts`、`model-gateway.ts`、Tool/Skill Registry 与 `proposals/[id]/confirm` 确认路径，形成调用链说明并在 TASK.md 记录验证结果；随后按清单推进模型网关异常、租户/用户/业务上下文、Tool/Skill Registry、经营管理查询工具与高风险确认验证。

## Verification

- [ ] `node .ai-team/check.mjs --base origin/main`：P08 定义提交后复跑，结果 valid、Private sessions disabled。
- [ ] P08 聚焦测试：`agent-orchestrator`、`agent-office-tool-registry`、`agent-native-tool-routing`、`agent-job-control`、`agent-api`、`postgres-agent-store`、`postgres-agent-worker`、`agent-security.eval` 等按实现进展执行并如实记录。
- [ ] `npm run typecheck` / `npm run lint`：按 P03/P06 已记录基线口径执行并记录。
- [ ] `git diff --check`：exit 0。
- [ ] `node .ai-team/session.mjs validate` / `report`：enabled: false，无错误。

## Handoff note

- From: `P08`
- To: `unassigned`
- Summary: 本提交为项目开启与 P08 任务定义（通用 Agent 调用链验证与工具/异常/确认机制补强）；实现尚未开始。P08 完成后按 TASK 记录手动交接；下一专项为验证工作任务认领、任务移交、消息池、事件恢复和分层记忆能力。
