# Current Task

- ID: `P10`
- Title: `全项目集成验收与最终交付`
- Status: `active`
- Owner: `P10`
- Next owner: `P01`

## Goal

在 P01-P09 已合并成果上执行最终集成验收，核对跨模块关键链路、安全不变量、数据库与 API 契约以及仓库工程门禁；修复可稳定复现且属于主项目范围的集成缺口，形成可由 P01 复核的最终交付证据。Pi Agent 二次开发专项和必须依赖真实外部凭据的验证不属于本任务实现范围，只记录真实状态。

## Acceptance scenarios

- [ ] P01-P09 的合并提交、TASK 交接链和当前主分支事实一致，仓库可仅凭版本化文件恢复上下文。
- [ ] 身份与客户端、经营管理、企业治理、工作流/会议/知识、管理智能、三方连接器、通用 Agent、任务指挥与分层记忆的关键回归通过或有可复现的阻塞记录。
- [ ] `typecheck`、Lint、生产构建和全量测试均已执行，结果、失败归属和环境边界如实记录；不得通过删除既有测试或放宽安全约束制造通过。
- [ ] 租户隔离、服务端当前权限、版本冲突、Outbox/幂等、回调防重放以及 R3/R4 人工确认等跨模块安全不变量得到复核。
- [ ] 数据库迁移、Route Handler、需求追踪和行为证据与当前实现保持一致，重新克隆后不存在被忽略或缺失的必要源码。
- [ ] 最终交付说明明确区分本地自动化通过、模拟/PGlite 证据和真实模型/真实 PostgreSQL/真实三方平台等外部 Gate，并准备 P01 复核。

## Invariants

- 保持租户隔离、服务端权限重算、数据范围过滤和失败关闭；不得信任请求体自报的租户、身份、版本或设备可信状态。
- 高风险业务副作用只能经 Tool Registry、持久化提案和人工确认执行；不得用 Agent 输出替代权威业务事实或验收证据。
- 不删除或弱化既有测试来消除失败；发现基线缺口时保留覆盖并修复最小根因。
- 不修改 Pi Agent 二次开发专项、真实平台配置、部署 Secret 或外部生产环境；相关失败单独归类，不冒充已通过。
- 不伪造测试、构建、真实联调或 CI 结果，不提交密钥、私人数据、运行产物或私有 Session 文件。
- 代码、测试、文档和 `.ai-team/TASK.md` 在同一 P10 PR 中同步更新。

## Decisions

- P07、P08、P09 已按依赖顺序完成复核与合并；P10 从 P09 合并提交 `265e446` 的最新 `main` 创建分支 `codex/p10-final-integration-acceptance`。
- P10 是主项目最终集成验收，不重做各阶段功能；先以失败证据定位跨模块或工程门禁缺口，再实施最小修复。
- P09 集成复核已证明删除测试会掩盖真实缺口；P10 继续坚持“保留覆盖、修复根因、如实记录外部阻塞”。
- P01 作为最终复核接收人；P10 完成后切换为 `handoff`，不虚构不存在的 P11。

## Completed

- 已确认 P07 PR #6 合并为 `fbd4325`，P08 PR #8 合并为 `2ca8d56`，P09 PR #9 合并为 `265e446`。
- 已确认最新 `main` 的 P09 状态为 `handoff`、`Next owner: P10`，接棒前 `node .ai-team/check.mjs --base origin/main` 返回 `Result: valid`。
- P09 集成修复保留 SSE 与跨租户记忆测试，恢复 Artifact 版本交接覆盖，补齐三个 Artifact Route，并将 `.gitignore` 根目录规则锚定为 `/artifacts/`。
- 接棒前 `npm run typecheck` 已恢复为 exit 0，工作区 clean，公开仓库 Private sessions 保持 disabled。
- 已从最新 `main` 创建 P10 分支并将任务切换为 `P10 / active`。
- P10 接棒提交 `b30ce5f` 已推送到团队分支，并创建 Draft PR #10；PR 在最终验收完成前保持 Draft。

## Pending

- 执行干净依赖安装、全仓 typecheck、Lint、生产构建和全量测试，保存真实汇总。
- 执行 P01-P09 跨模块关键回归和安全不变量检查，定位可稳定复现的主项目集成缺口。
- 对范围内缺口实施最小修复并补充回归；Pi Agent 专项或真实外部 Gate 仅记录，不扩大范围。
- 更新最终交付证据、将 Draft PR #10 转为 ready、切换为 handoff，等待 P01 复核。

## Next step

在 P10 分支运行 `npm ci`、`npm run typecheck`、`npm run lint`、`npm run build` 和 `npm test`，随后按 P01-P09 模块边界执行聚焦回归；根据失败证据区分主项目缺口、Pi Agent 专项问题和真实外部 Gate。

## Verification

- [x] P09 PR #9 最新 GitHub `repo-task-sync`：通过。
- [x] P09 合并后 `node .ai-team/check.mjs --base origin/main`：exit 0，7/7，`Result: valid`，Private sessions disabled。
- [x] P09 合并后 `npm run typecheck`：exit 0。
- [x] P10 接棒前本地 `main` 与 `origin/main` 均位于 `265e446`，工作区 clean。
- [x] P10 active 状态 `node .ai-team/check.mjs --base origin/main`：exit 0，0/6，`Result: valid`，Private sessions disabled。
- [x] P10 Draft PR #10 已创建，当前保持 `active`，未把接棒状态误报为最终完成。
- [ ] P10 全仓工程门禁与跨模块聚焦回归。

## Handoff note

- From: `P09`
- To: `P10`
- Summary: P09 已完成任务指挥与分层记忆验证，并在集成复核中恢复 Artifact 交接覆盖和缺失 API Route，使全仓 typecheck 恢复通过。P10 从合并提交 `265e446` 接棒，负责主项目最终集成验收、范围内最小修复和真实证据汇总；Pi Agent 二次开发专项与真实外部平台 Gate 不在实现范围。
