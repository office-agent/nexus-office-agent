# Current Task

- ID: `P03`
- Title: `经营管理闭环验证`
- Status: `handoff`
- Owner: `lbz0000ff`
- Next owner: `P04`

## Goal

梳理并验证 Nexus Office Agent 的经营管理闭环，确保目标、项目、风险/问题、决策、行动与完成证据通过一致的 API、领域服务、仓储和 Outbox 链路形成可追踪、可持久化且可测试的业务事实。

## Acceptance scenarios

- [x] 梳理目标、项目、风险/问题、决策、行动与完成证据的领域模型、状态转换和关联约束。
- [x] 沿管理 API、应用服务、仓储、Outbox 与测试梳理完整调用链，并明确 `governance-workspace` 的集成边界。
- [x] 运行 management-loop 相关单元、API 与 PostgreSQL 仓储测试并记录真实结果。
- [x] 找出一至两个可由失败测试稳定复现的经营管理闭环缺口，并提出最小修复方案。
- [x] 经方案确认后完成范围内工程改进及回归测试。
- [x] 相关检查和 VibeCollab 协作检查取得真实结果并记录。

## Invariants

- 经营管理事实必须保持租户隔离、服务端授权、审计可追踪和高风险动作人工确认边界。
- 业务写入、状态转换和 Outbox 事件不得形成已提交一侧而丢失另一侧的不可恢复状态。
- 完成证据必须关联到受约束的行动和业务上下文，不能由客户端自报替代服务端事实。
- `governance-workspace` 只检查与 management-loop 的集成边界，不扩展为其工作流、知识或会议能力的全面改造。
- 不修改 Pi Agent、Artifact Route、跨平台测试或依赖审计相关实现；这些全仓库基线问题不属于 P03。
- 公开仓库继续禁用 VibeCollab 私有会话记录，不提交密钥、真实企业配置或运行产物。

## Decisions

- P03 从已合并 P02 的最新 `origin/main` 创建独立分支 `codex/p03-management-loop`。
- 主要代码范围为 `src/modules/management-loop`、`app/api/v1/management` 和对应测试；`src/modules/governance-workspace` 仅检查集成边界。
- 调查按 `API → service → repository → outbox → tests` 展开，先以失败测试证明缺口，再提出最小修复方案。
- 调查阶段只更新本任务文件；方案获批后实施产品代码与测试，但在再次确认前不提交、不推送、不创建 PR。
- P01/P02 已记录的 Artifact Route、跨平台测试和 npm audit 问题保留为项目基线事实，不作为 P03 默认修复项。
- management-loop 的命令仓储同时拥有业务写入和 Outbox 插入，使 PostgreSQL 实现在同一个 tenant transaction 中提交；内存实现覆盖普通 Outbox 失败的回滚语义，不将其视为数据库事务的完整并发等价物。
- action completion 和 task transition 的 HTTP 契约要求提交当前 `version`，仓储使用 compare-and-set，冲突返回 `409`。

## Completed

- 已确认 P02 handoff 提交 `f8102be` 同时位于本地 `main` 与 `origin/main`，并以 fast-forward-only 拉取确认远端无更新。
- 已确认 P02 的 `Status: handoff`、`Next owner: P03`，且交接协作检查结果为 `valid`。
- 已运行 `npm ci`，按锁文件安装依赖；未启用公开仓库禁止的私有会话记录。
- 已创建 P03 独立分支，并将当前任务切换为 P03/active，唯一写入者为 `lbz0000ff`。
- 已沿 Route Handler、可信请求上下文、`ManagementLoopService`、内存/PostgreSQL 仓储、EventStore、Outbox Worker 和正式测试梳理闭环；`governance-workspace` 仅通过 `MeetingService` 将确认纪要物化为 management-loop 决策与行动。
- 已用临时故障注入红测复现业务写入与 Outbox 非原子：`appendOutbox` 抛错后风险仍从 1 条增加到 2 条；临时测试已删除。
- 已用临时并发屏障红测复现行动完成缺少 CAS：同一 action version 的两个并发 `completeAction` 调用均成功；临时测试已删除。
- 已确认持久化 Outbox Worker 自身具备租约、重试和发布回执幂等，但这不能补偿 management-loop 在 Outbox 入队前已经发生的业务写入，也不能阻止并发业务状态覆盖。
- 已将三个调查缺口固化为正式失败测试：未知风险可进入决策、Outbox 失败残留业务事实、同一行动版本并发完成双成功；修改前 3 项均稳定失败。
- 已增加风险关系校验：决定和问题引用风险时，服务端确认风险存在且属于当前租户和项目，PostgreSQL 决策事务再次校验项目关系。
- 已将风险、决定及行动项、决定替代、行动完成、任务迁移、问题写入与各自 Outbox 事件合并到仓储原子命令；Outbox 写入失败时 PostgreSQL 与内存事实均回滚。
- 已为行动完成和任务迁移增加 expected-version/CAS；网页客户端和 Route Handler 提交当前版本，旧版本请求返回 `409`。
- 已升级 PostgreSQL 闭环测试，覆盖目标/项目、风险、决定、行动、完成证据、Owner、Outbox、actor/trace 审计和故障回滚；同步更新 API/事件契约、需求追踪和行为证据。
- 已验证 `MeetingService` 确认纪要仍通过同一 management-loop 服务物化决定与行动项，未扩展 governance-workspace 的其他能力。

## Pending

- 管理页面当前只提交一个决策候选项，而 API 契约要求至少两个；这是既有前端产品体验问题，不属于 P03 的 API → service → repository → outbox 验证范围，交由后续前端阶段处理。
- 内存仓储未承诺覆盖“延迟 Outbox 失败与后续并发写入交错”的完整事务隔离；生产 PostgreSQL 路径已由同事务写入和故障回滚测试验证。
- `MeetingService.confirm` 的跨 meeting、management-loop 与 meeting event 多段事务可作为同类集成风险记录，但本阶段不将 governance-workspace 扩入 P03 产品改造。
- 全仓库 TypeScript 与测试仍分别受 P01 已记录的 Artifact Route 缺失、Windows Firecracker 路径问题影响；全量测试并发运行另出现 3 个 Node Worker OOM，P03 聚焦回归未复现。

## Next step

复核最终暂存差异；获得提交授权后将 P03 代码、测试、文档和本任务文件作为同一提交交付，再经明确授权推送并创建 PR。

## Verification

- [x] `npm ci` — exit 0；按锁文件安装 601 个包；报告安装脚本策略警告，未据此扩大 P03 范围
- [x] 接棒前 `node .ai-team/check.mjs --base origin/main` — exit 0；P02 functional progress 6/6，0 commits，0 files，Result: valid，Private sessions disabled
- [x] management-loop 相关单元、API、PostgreSQL 仓储基线 — 3 files，13 tests passed
- [x] management-loop 加 governance-workspace 集成边界回归 — 5 files，19 tests passed
- [x] 临时故障注入红测 — 1 file，2 tests failed as expected；分别复现 Outbox 失败残留业务事实和并发行动完成双成功；临时文件已删除
- [x] 正式修改前红测 — `management-loop.test.ts` 3 tests failed、6 passed；分别证明风险关系、原子 Outbox 和并发 CAS 缺口
- [x] P03 核心与 governance 边界回归 — 6 files，28 tests passed
- [x] 受构造器和管理服务影响的 Agent、渠道、评测、性能回归 — 8 files，34 tests passed
- [x] 扩展相关回归与需求追踪 — 13 files，56 tests passed（新增 API 关系测试前）；后续核心回归已包含新增用例
- [x] `npm run lint` — exit 0，0 errors，0 warnings
- [x] `npm run typecheck` — exit 1；仅剩 P01 已记录的 3 个 Artifact Route 模块缺失，未出现 P03 类型错误
- [x] `npm test` — exit 1；114 files passed、8 skipped、2 failed，434 tests passed、26 skipped、4 failed；失败为已排除的 4 项 Windows Firecracker 路径测试和 Artifact Route 缺失，另有 3 个全量并发 Worker OOM
- [x] handoff 前聚焦回归复跑 — 6 files，28 tests passed；`npm run lint` 与 `git diff --check` 均 exit 0
- [x] handoff 状态 `node .ai-team/check.mjs --base origin/main` — exit 0；P03 functional progress 6/6，0 commits，25 files，Result: valid，Private sessions disabled

## Handoff note

- From: `lbz0000ff`
- To: `P04`
- Summary: P03 已完成经营管理关系校验、生产 PostgreSQL 业务写入与 Outbox 原子化、行动/任务版本 CAS 和端到端审计证据；既有页面候选项问题及内存仓储完整并发事务隔离已明确留作后续边界，待提交并创建 PR 后由 P04 从合并提交接棒。
