# Current Task

- ID: `P06`
- Title: `企业与管理智能验证与数据质量补强`
- Status: `handoff`
- Owner: `P06`
- Next owner: `P07`

## Goal

依据企业管理、管理智能、权限安全和 API 契约文档，验证并补强企业与管理智能能力，使指标口径、来源和质量状态可追溯，且数据质量能明确影响管理分析；同时保留管理节奏、组合情景、企业事项和 AI 治理的既有安全边界与自动化证据。

## Acceptance scenarios

- [x] 指标定义、权威来源、定位、新鲜度 SLA、允许/禁止用途和更新时间可从工作区与 API 追溯。
- [x] 缺失、过期、待核验数据均显式显示为相应质量状态，并实际影响管理例外摘要和会前分析。
- [x] 管理节奏、组合情景的假设/项目动作/容量/收益/成本/风险/证据，以及人工版本化选择均保持可复核。
- [x] 企业事项的来源、责任、SLA、状态迁移和证据链，以及 AI 治理的小样本/未知结果边界均保持受测。
- [x] P06 聚焦单元、API、PostgreSQL、类型、Lint、构建和仓库同步检查已执行并如实记录结果或既有基线阻塞。

## Invariants

- 保持租户隔离、服务端权限校验、数据范围过滤和失败关闭；不得信任请求体自报的租户或操作者。
- 管理分析严格区分事实、推断和需要人工决定的提案；不得把 AI 输出或缺失/失鲜数据包装为正式健康结论。
- 所有写操作继续使用对象版本或 compare-and-set；组合选择同一组合只能有一个当前选定方案并保留历史。
- 指标、情景、事项和 AI 治理只保存设计要求的可审计摘要，不引入原始敏感提示、完整模型响应或人才私密数据。
- 不修改无关的 Pi Agent、连接器、部署、身份权限或企业治理模块；不处理 P03 已记录的全仓基线问题。
- 不伪造测试结果，不提交密钥、私人数据、运行产物或私有 Session 文件。

## Decisions

- P05 已由 PR #4 合并为提交 `d3d0fec`；P06 从最新 `main` 创建分支 `codex/p06-enterprise-management-intelligence` 并接棒。
- P06 范围限定为 `src/modules/enterprise-intelligence`、`src/modules/management-intelligence`、`src/modules/strategy`、`src/modules/talent` 及其直接 API、测试和必要文档。
- 开发环境使用 lockfile 安装的依赖和内存/PGlite fixture；公开仓库继续禁用 VibeCollab Private Session、Hook 与任何真实凭据。真实模型、PostgreSQL 和企业微信凭据仍只属于本机或部署 Secret 管理。
- 质量状态以同一条最新检查解释；无检查的受管指标在工作区、例外摘要和会前事实中均为 `missing`。例外摘要单列失鲜/缺失和 `unverified`，避免把待核验数据混同为健康或过期。
- 多条质量检查以 `checkedAt` 为主、ID 为确定性并列规则选择最新项；PostgreSQL/PGlite 回归覆盖同一检查时间的稳定结果。
- 新建组合情景必须只引用该组合已纳入的项目；服务层与内存/PostgreSQL 仓储均执行同一成员范围校验，避免把同租户但组合外项目写入情景。
- 当前仓库未启用 `.ai-team/session-policy.json`，`session.mjs validate` 明确报告 `enabled: false`。这不构成原方案 Private 会话采集证据，P07 不得将其误报为已启用。

## Completed

- 已确认本地 `main` 与 `origin/main` 一致，P05 合并提交为 `d3d0fec`，接棒前工作区为 clean。
- 已创建 P06 分支 `codex/p06-enterprise-management-intelligence`。
- 已阅读共享项目、任务与协作规范，P06 测试方案，管理智能/需求追踪设计文档，以及当前 Next.js 环境变量和 Route Handler 约定。
- 已执行 `npm ci`；依赖按 lockfile 成功安装。npm 报告 2 个已有审计问题（1 moderate、1 high），未执行自动升级或修复。
- 已完成初步领域、应用服务、仓储、API 与测试盘点，确认管理节奏、指标语义、组合情景、企业事项和 AI 治理已有实现与回归覆盖。
- 工作区现在将没有质量检查的受管指标计入失鲜/缺失例外；待核验指标单列为 `unverifiedMetrics`，前端摘要和指标徽标均显式呈现状态。
- 会前事实包使用相同的最新质量解释，并扩展情景事实以保留假设、适用组合/项目、动作、容量、收益、成本、风险和证据引用。
- 组合情景创建前验证每个项目属于指定组合；相关内存/PostgreSQL 实现继续以租户范围和 RLS 执行查询。
- 已更新管理智能设计规则及行为证据映射；PGlite 回归覆盖 missing、unverified、stale、同时间戳确定性选择和组合外项目拒绝。
- P06 聚焦回归：`tests/unit/management-intelligence.test.ts`、`tests/integration/management-intelligence-api.test.ts`、`tests/integration/postgres-management-intelligence.test.ts`、`tests/requirement-traceability.test.ts` 共 4 个文件、16 项测试通过。

## Pending

- P06 代码与 TASK 已到可合并检查点；待推送并通过 PR 后由 P07 接棒。当前环境的 GitHub CLI 令牌失效且无法解析 GitHub，不能在本轮创建/更新远端 PR。
- 全仓 `typecheck` 仍只报告 P03 已记录的 3 个 Task Command Artifact Route 模块缺失；构建在编译成功后因环境中的 TypeScript `--showConfig` 解析异常而 `exit 134`。
- 全量 `npm test` 在输出多项已知 Pi/Task Command 范围外失败后未自行结束，被人工中止为 `exit 130`；不得把它表示为通过。P10 应在具备 Pi 运行时/稳定测试环境时重新取得完整全量汇总。
- 真实模型、真实 PostgreSQL、三方企业平台和生产运行时仍属于外部验证 Gate；P07 负责记录连接器本地模拟、接口测试和真实平台联调状态。

## Next step

P07 在 P06 PR 合并后从最新 `main` 创建分支，先阅读项目与任务上下文；随后从 `src/modules/integration` 的统一 Connector、外部身份映射和事件入口开始，验证企业微信、飞书和钉钉的签名/时间窗/解密、租户解析、幂等投递和测试通知状态，并把本地、模拟与真实平台证据分别写入 TASK。

## Verification

- [x] P05 合并检查：本地 `main` 与 `origin/main` 均位于 `d3d0fec`。
- [x] `npm ci`：exit 0；安装 611 个包；报告 2 个已有依赖审计问题，未执行自动修复。
- [x] P06 聚焦单元、API、PostgreSQL、需求追踪回归：exit 0；4 个测试文件、16 项通过。
- [x] `npm run typecheck`：exit 2；仅报告 P03 已记录的 3 个 `task-command/artifacts` Route 模块缺失，未出现 P06 类型错误。
- [x] `npm run lint`：exit 0。
- [x] `npm test`：命令已执行但未自行收尾；输出后被人工中止为 exit 130。中止前报告 `firecracker-backend`（4）、`pi-resource-materializer`（1）、`task-command-api`（0 tests，缺失 Route）、`pi-sandbox-supervisor`（2）、`pi-workspace-supervisor-object`（2）和 `pi-workspace-supervisor-http`（3）等范围外失败；没有把不完整结果当作通过。
- [x] `npm run build`：exit 134；优化生产编译成功，随后 TypeScript `--showConfig` 解析输出失败并 core dump，未出现 P06 编译错误。
- [x] `git diff --check`：exit 0。
- [x] `node .ai-team/check.mjs --base origin/main`：exit 0，更新状态前结果 valid、Private sessions disabled；交接状态更新后需在提交前复跑。
- [x] `node .ai-team/session.mjs validate`：exit 0，`enabled: false`、无错误；不是 Private Session 验收。
- [x] `node .ai-team/session.mjs report`：exit 0，0 个 session、Private sessions disabled。

## Handoff note

- From: `P06`
- To: `P07`
- Summary: P06 已完成指标质量与管理分析的一致性补强：missing/unverified/stale 在工作区摘要和会前事实中可追溯，组合情景受组合项目范围约束，情景事实保留可复核的假设、动作与证据。P06 聚焦 16 项回归、Lint、差异和仓库同步检查通过；全仓 TypeScript、测试与构建的真实范围外/环境阻塞已如实记录。P07 从统一 Connector 与事件入口继续，不重做 P06 范围。
