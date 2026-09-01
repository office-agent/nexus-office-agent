# Current Task

- ID: `P09`
- Title: `工作指挥中心与分层记忆验证`
- Status: `handoff`
- Owner: `Copilot`
- Next owner: `P10`

## Goal

验证任务认领、任务移交、消息池、SSE 事件恢复和分层记忆能力，并交付一项测试补强成果：
- 断线后续传不重复（SSE 游标恢复）
- 跨租户记忆隔离（共享记忆范围过滤）

## Acceptance scenarios

- [x] 任务发布、直接分配、开放认领、并发唯一认领均可工作。
- [x] 任务移交保留快照与验收信息，交接链稳定。
- [x] SSE 事件支持断线恢复：`after` / `Last-Event-ID` 续传只返回新增事件。
- [x] 记忆访问符合租户 + 任务范围，跨租户不能互读共享记忆。
- [x] 相关模块测试通过。
- [x] 测试补强已落地，且需求追踪头注释符合要求。
- [x] 原有 Artifact 版本交接覆盖得到保留，缺失的三个 Task Command Artifact Route 已补齐并通过类型与接口回归。

## Invariants

- 保持租户隔离、服务端权限校验、数据范围过滤和失败关闭；不信任请求体自报租户或操作者。
- 优先补充显式测试与夹具；集成复核不得以删除既有覆盖绕过基线缺口，确需修复时只补齐已有服务能力对应的最小 API 入口。
- 不伪造测试结果，不提交密钥、私人数据、运行产物或私有 Session 文件。
- 公开仓库继续禁用 VibeCollab Private Session 与真实凭据。

## Decisions

- P09 采用“测试补强”交付类型，而不重写业务逻辑。
- 重点覆盖的文档点为任务指挥中枢与分层记忆的断线恢复、租户隔离与事件游标行为。
- 现有仓库中任务命令和记忆实现已具备这两类能力，缺的是明确回归测试证明。
- 集成复核发现原提交删除 Artifact Route 引用和版本冻结测试以绕过缺失模块；决定恢复既有测试，并仅将已有 `TaskCommandService` Artifact 能力接入三个 Route Handler，不修改领域或仓储语义。
- Artifact Route 长期未进入仓库的根因是 `.gitignore` 中未锚定的 `artifacts/` 会忽略任意层级同名目录；规则收紧为 `/artifacts/`，仍忽略根目录运行产物，同时允许 API 路由被版本控制。

## Completed

- 验证任务命令模块：发布、认领、推进、消息池、交接链与状态机行为。
- 验证分层记忆模块：conversation、context、task、situational、long_term 的范围与权限过滤。
- 新增回归测试：
  - `tests/unit/agent-memory.test.ts`：跨租户共享记忆隔离
  - `tests/integration/task-command-api.test.ts`：SSE 续传不重复
- 两段测试首行均附带规范注释，满足需求追踪 Gate。
- P07 PR #6 与 P08 PR #8 已依次合并；P09 分支已同步最新 `main`，保留 P07/P08 产品代码和 P09 handoff 状态。
- 已恢复 Artifact 版本冻结、脱敏读取和后续版本追加测试，并新增注册、读取和追加版本三个 Route Handler；全仓 typecheck 因此从 3 个缺失模块恢复为通过。
- 已将根目录运行产物忽略规则锚定为 `/artifacts/`，确认三个 Route 文件可被 Git 跟踪，重新克隆后不会再次缺失。
- P09 集成修复已通过提交 `649e387` 推送到团队分支，并创建 PR #9。

## Pending

- PR #9 等待最新 GitHub 检查、复核与合并；合并后由 P10 从最新 `main` 正式接棒。

## Next step

P09 PR 检查通过并合并后，P10 拉取最新 `main`，创建 P10 分支，将 `Owner` 更新为 P10、`Status` 更新为 `active`，开始最终集成验收与全量回归。

## Verification

- [x] `npx vitest run tests/unit/agent-memory.test.ts tests/integration/task-command-api.test.ts`：2 个测试文件通过，11/11 测试通过。
- [x] `node .ai-team/check.mjs --base origin/main`：`Result: valid`。
- [x] `node .ai-team/session.mjs validate`：`valid: true`，`enabled: false`。
- [x] `npm run lint`：exit 0。
- [x] 集成修复后聚焦回归：`agent-memory`、`task-command-api`、`task-command`、`postgres-task-command` 共 4 个测试文件、20 项通过。
- [x] 集成修复后 `npm run typecheck`：exit 0；此前 3 个 Task Command Artifact Route 缺失已消除。
- [x] 集成修复改动文件 ESLint：exit 0。
- [x] PR #9 已创建，代码、测试和 TASK 位于同一 PR。

## Handoff note

- From: `P09`
- To: `P10`
- Summary: P09 已完成工作指挥中心与分层记忆的关键能力验证，补强 SSE 断线续传和跨租户记忆隔离测试；集成复核恢复了被删除的 Artifact 交接覆盖，并补齐三个最小 Route Handler，使全仓 typecheck 恢复通过。P09 合并后由 P10 从最新主分支执行最终集成验收与全量回归。
