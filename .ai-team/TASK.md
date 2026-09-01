# Current Task

- ID: `P10`
- Title: `全项目集成验收与最终交付`
- Status: `handoff`
- Owner: `P10`
- Next owner: `P01`

## Goal

在 P01-P09 已合并成果上执行最终集成验收，核对跨模块关键链路、安全不变量、数据库与 API 契约以及仓库工程门禁；修复可稳定复现且属于主项目范围的集成缺口，形成可由 P01 复核的最终交付证据。Pi Agent 二次开发专项和必须依赖真实外部凭据的验证不属于本任务实现范围，只记录真实状态。

## Acceptance scenarios

- [x] P01-P09 的合并提交、TASK 交接链和当前主分支事实一致，仓库可仅凭版本化文件恢复上下文。
- [x] 身份与客户端、经营管理、企业治理、工作流/会议/知识、管理智能、三方连接器、通用 Agent、任务指挥与分层记忆的关键回归通过或有可复现的阻塞记录。
- [x] `typecheck`、Lint、生产构建和全量测试均已执行，结果、失败归属和环境边界如实记录；不得通过删除既有测试或放宽安全约束制造通过。
- [x] 租户隔离、服务端当前权限、版本冲突、Outbox/幂等、回调防重放以及 R3/R4 人工确认等跨模块安全不变量得到复核。
- [x] 数据库迁移、Route Handler、需求追踪和行为证据与当前实现保持一致，重新克隆后不存在被忽略或缺失的必要源码。
- [x] 最终交付说明明确区分本地自动化通过、模拟/PGlite 证据和真实模型/真实 PostgreSQL/真实三方平台等外部 Gate，并准备 P01 复核。

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
- Windows 全量测试固定使用 `--maxWorkers=2`，避免测试进程并发导致的本机内存压力；不改变测试集合、断言或安全约束。
- 首次生产构建因本机 AppData 中 Next.js telemetry 配置跨盘重命名触发 `EXDEV`，以 `NEXT_TELEMETRY_DISABLED=1` 隔离该环境写入后构建通过；该失败归类为本机环境问题，不归类为产品代码缺陷。
- 依赖审计发现 `ajv@6.12.6` 和传递依赖 `nanoid@3.3.17` 的已知漏洞；采用兼容的小版本安全更新并完成全部门禁复测，不扩大到 Pi Agent 二次开发专项。

## Completed

- 已确认 P07 PR #6 合并为 `fbd4325`，P08 PR #8 合并为 `2ca8d56`，P09 PR #9 合并为 `265e446`。
- 已确认最新 `main` 的 P09 状态为 `handoff`、`Next owner: P10`，接棒前 `node .ai-team/check.mjs --base origin/main` 返回 `Result: valid`。
- P09 集成修复保留 SSE 与跨租户记忆测试，恢复 Artifact 版本交接覆盖，补齐三个 Artifact Route，并将 `.gitignore` 根目录规则锚定为 `/artifacts/`。
- 接棒前 `npm run typecheck` 已恢复为 exit 0，工作区 clean，公开仓库 Private sessions 保持 disabled。
- 已从最新 `main` 创建 P10 分支并将任务切换为 `P10 / active`。
- P10 接棒提交 `b30ce5f` 已推送到团队分支，并创建 Draft PR #10；PR 在最终验收完成前保持 Draft。
- 已完成干净依赖安装；最终安装 611 个包、审计 612 个包，`npm audit` 返回 0 个漏洞。`ajv` 更新为 `6.15.0`，锁文件中的 `nanoid` 更新为 `3.3.18`。
- 全仓 `typecheck`、Lint 和生产构建均通过；生产构建生成 38 个静态页面，并列出三个 Artifact Route Handler。
- 全量测试最终结果为 125 个测试文件通过、8 个跳过，491 个测试通过、26 个跳过，共 133 个文件、517 个测试，exit 0。
- P01-P09 聚焦跨模块回归共 27 个测试文件、146 个测试通过，覆盖客户端策略、生产身份、经营管理、企业治理、工作流/会议/知识、管理智能、连接器安全、Agent 编排、任务指挥、分层记忆、数据库迁移和需求追踪。
- 已通过现有回归复核租户隔离、服务端权限重算、版本冲突、Outbox/幂等、回调防重放以及 R3/R4 人工确认等安全不变量，未删除测试或放宽约束。
- 已核对 Artifact 三个 Route 文件均由 Git 跟踪且不受 `.gitignore` 影响；迁移、Route Handler、需求追踪及 TASK 交接证据保持在版本库内。
- 公开仓库 Private sessions 保持 disabled，未提交 Session 文件、密钥、私人数据或运行产物。

## Pending

- P01 复核并合并 PR #10；本任务不代替最终接收人完成业务验收决策。
- 真实模型、真实 PostgreSQL 服务、企业微信/飞书/钉钉/IdP、部署环境及其外部凭据未在本地提供，属于独立外部 Gate；当前通过证据来自自动化测试、模拟实现和 PGlite，不将其表述为真实平台联调通过。
- Pi Agent 二次开发专项未修改、未验收，继续按原定范围单独处理。

## Next step

P01 查看 PR #10 的最终差异和最新 CI，确认本地自动化证据与外部 Gate 边界后决定合并；具备真实 PostgreSQL、模型、企业平台凭据和部署环境时，再按对应清单执行外部集成验收。

## Verification

- [x] P09 PR #9 最新 GitHub `repo-task-sync`：通过。
- [x] P09 合并后 `node .ai-team/check.mjs --base origin/main`：exit 0，7/7，`Result: valid`，Private sessions disabled。
- [x] P09 合并后 `npm run typecheck`：exit 0。
- [x] P10 接棒前本地 `main` 与 `origin/main` 均位于 `265e446`，工作区 clean。
- [x] P10 active 状态 `node .ai-team/check.mjs --base origin/main`：exit 0，0/6，`Result: valid`，Private sessions disabled。
- [x] P10 Draft PR #10 已创建，当前保持 `active`，未把接棒状态误报为最终完成。
- [x] `npm ci`：exit 0；最终安装 611 个包、审计 612 个包，0 个漏洞。
- [x] `npm audit --json`：exit 0，0 个漏洞；`ajv@6.15.0`、`nanoid@3.3.18` 已落锁。
- [x] `npm run typecheck`：exit 0。
- [x] `npm run lint`：exit 0。
- [x] `$env:NEXT_TELEMETRY_DISABLED='1'; npm run build`：exit 0；首次未禁用 telemetry 的 `EXDEV` 已如实归类为本机 AppData 跨盘写入问题。
- [x] `npm test -- --maxWorkers=2`：exit 0；125 passed / 8 skipped files，491 passed / 26 skipped tests。
- [x] P01-P09 聚焦回归：exit 0；27 个测试文件、146 个测试通过。
- [x] `git ls-tree -r --name-only HEAD -- app/api/v1/task-command/artifacts`：三个 Artifact Route 文件均已跟踪；`git check-ignore --no-index` 未命中。
- [x] P10 全仓工程门禁、跨模块回归、安全不变量和版本化交接证据已完成；真实外部 Gate 状态已单独记录。

## Handoff note

- From: `P10`
- To: `P01`
- Summary: P10 已在 P01-P09 合并基线上完成主项目最终集成验收：全仓类型检查、Lint、生产构建、全量测试和 27 文件跨模块回归通过，依赖审计降为 0 个漏洞，Artifact Route 与交接文件确认可被 Git 恢复。当前证据覆盖本地自动化、模拟和 PGlite；真实模型、真实 PostgreSQL、企业平台、IdP 与部署环境仍是独立外部 Gate，Pi Agent 二次开发专项保持未改动。请 P01 复核 PR #10 并决定合并。
