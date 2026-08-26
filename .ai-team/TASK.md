# Current Task

- ID: `P04`
- Title: `企业治理模块验证`
- Status: `handoff`
- Owner: `fjf1113`
- Next owner: `P05`

## Goal

通过现有领域代码、应用服务、仓储和测试验证企业治理的主要业务流程，并补充一个明确的边界测试，形成可重复验证、可安全交接的工程检查点。

## Acceptance scenarios

- [x] 梳理组织调整和人员离职责任移交的实现链路及测试证据。
- [x] 梳理项目基线变更和项目关闭的实现链路及测试证据。
- [x] 梳理重点关注事项、审计和补偿机制的实现链路及测试证据。
- [x] 运行企业治理相关单元、API 和 PostgreSQL 测试并记录真实结果。
- [x] 补充“补偿计划过期后拒绝执行且项目数据保持不变”的单元测试。
- [x] 运行相关回归和 VibeCollab 检查，记录真实结果并准备 P05 交接。

## Invariants

- 保持租户隔离、服务端权限校验、版本冲突保护和审计可追踪。
- 高风险治理动作必须遵守现有职责分离和人工确认边界。
- 优先补充测试；只有测试稳定证明存在真实缺陷时，才提出最小产品代码修复。
- 默认只修改 `src/modules/enterprise-governance`、对应测试、必要文档和 `.ai-team/TASK.md`。
- 不修改权限底层、Pi Agent、Worker、部署及其他无关模块。
- 不扩大处理 P03 已记录的全仓库基线问题。
- 不伪造或推测测试结果。
- 公开仓库不提交密钥、私人数据、原始工具输出、运行产物或私有 Session 文件。

## Decisions

- P04 首个可合并成果选择治理流程测试，不主动进行大范围重构。
- 按“领域规则 → 应用服务 → 仓储 → API → 测试”顺序梳理实现。
- 先运行现有聚焦测试，再补充补偿计划过期边界测试。
- 如果新增测试发现产品缺陷，先记录失败证据和最小修复方案，等待确认后再修改产品代码。
- P03 已记录的 Artifact Route、Windows Firecracker、全量测试内存和依赖审计问题不作为 P04 默认修复项。

## Completed

- P03 已通过提交 `f4c713e` 合并并交接给 P04。
- 已创建分支 `codex/p04-enterprise-governance`。
- `npm ci` 已成功安装 606 个包；安装过程报告已有的 2 个依赖审计问题，未执行自动修复或依赖升级。
- 接棒前 `node .ai-team/check.mjs --base origin/main` 返回 `Result: valid`。
- 接棒前工作区为 clean 状态。
- 公开仓库的 Private sessions 保持 disabled。
- 已按领域规则、应用服务、仓储、API 和测试梳理组织调整与离职责任移交、项目基线变更与关闭、重点关注、审计和补偿机制的实现链路及现有测试证据。
- P04 原始聚焦基线为 3 个测试文件、12 个测试通过。
- 已增加补偿计划过期边界单元测试，验证在 `expiresAt` 时执行被拒绝为 `COMPENSATION_EXPIRED`，且项目与补偿计划均保持不变。
- 新增测试后的单元测试为 1 个测试文件、8 个测试通过；P04 聚焦回归为 3 个测试文件、13 个测试通过。
- 本次未修改 `src/modules/enterprise-governance` 或其他产品代码。
- 交付前最新 P04 聚焦回归和 lint 均通过；typecheck 仅报告 P03 已记录的 3 个 Artifact Route 模块缺失，未出现 P04 类型错误。
- handoff 状态 VibeCollab 检查返回 `Result: valid`，Private sessions 保持 disabled。
- P04 变更已通过提交 `3a2ff00` 提交并推送，已创建 PR #3。
- PR #3 的最新 GitHub `repo-task-sync` 自动检查已通过。
- PR #3 评审期间，负责人独立复跑 P04 聚焦回归，3 个测试文件、13 项测试全部通过；`node .ai-team/check.mjs --base origin/main` 返回 `Result: valid`。

## Pending

- 全仓库 typecheck 仍受 P03 已记录的 3 个 Artifact Route 模块缺失影响。
- PR #3 当前为 open，等待负责人复审并合并。
- P05 必须等待 PR #3 合并到 `main` 后，再从最新 `main` 创建 P05 分支并接棒。

## Next step

PR #3 复审、检查通过并合并到 `main` 后，由 P05 拉取最新 `main` 验收交接，创建 P05 分支，将 `Owner` 更新为 P05、`Status` 更新为 `active`，再开始 P05 工作。

## Verification

- [x] `npm ci`：exit 0，安装 606 个包；报告 2 个已有依赖审计问题，未执行自动修复。
- [x] 接棒前 `node .ai-team/check.mjs --base origin/main`：exit 0，`Result: valid`。
- [x] P04 原始单元、API 和 PostgreSQL 聚焦基线：exit 0，3 个测试文件、12 个测试通过。
- [x] 新增补偿计划过期测试后的单元测试：exit 0，1 个测试文件、8 个测试通过。
- [x] P04 交付前最新聚焦回归：exit 0，3 个测试文件、13 个测试通过。
- [x] `npm run lint`：exit 0，0 errors，0 warnings。
- [x] `npm run typecheck`：exit 1；仅 `tests/integration/task-command-api.test.ts` 第 10 至 12 行报告 3 个已记录的 Artifact Route 模块缺失 `TS2307`，未出现 P04 类型错误。
- [x] `git diff --check`：exit 0。
- [x] handoff 状态 `node .ai-team/check.mjs --base origin/main`：exit 0，`Result: valid`，Private sessions disabled。
- [x] PR #3 已创建，最新 GitHub `repo-task-sync` 自动检查通过。
- [x] PR #3 评审复跑：3 个测试文件、13 项测试全部通过；`node .ai-team/check.mjs --base origin/main` 返回 `Result: valid`。
- [x] 交接事实更新后 `node .ai-team/check.mjs --base origin/main`：exit 0，`Result: valid`，Private sessions disabled。
- [x] 交接事实更新后 P04 聚焦回归：exit 0，3 个测试文件、13 项测试全部通过。
- [x] 交接事实更新后 `npm run lint`：exit 0。
- [x] 交接事实更新后 `npm run typecheck`：exit 1；仍仅报告 P03 已记录的 3 个 Artifact Route 模块缺失 `TS2307`，未出现新增错误。

## Handoff note

- From: `fjf1113`
- To: `P05`
- Summary: P04 已完成组织调整与离职责任移交、项目基线变更与关闭、重点关注、审计和补偿机制的实现链路验证；新增补偿计划在 `expiresAt` 时拒绝执行且项目与计划保持不变的单元测试。PR #3 已创建，最新 GitHub `repo-task-sync` 自动检查通过；交付前与评审复跑均为 3 个聚焦测试文件、13 项测试通过。产品代码无需修改；typecheck 仅有已记录的 3 个 Artifact Route 模块缺失，未出现 P04 类型错误。P05 应在 PR #3 合并后从最新 `main` 创建 P05 分支并将任务切换为 P05/active。
