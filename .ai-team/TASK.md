# Current Task

- ID: `P01`
- Title: `项目基线与 VibeCollab 初始化`
- Status: `handoff`
- Owner: `dyingforge`
- Next owner: `917135271`

## Goal

在公开仓库中完成可复现的项目工程基线与 VibeCollab 0.5.0 初始化，记录依赖安装、类型检查、代码规范、自动化测试、生产构建和协作检查的真实结果，使后续负责人能够仅通过 Git 与 Pull Request 获取同一份项目事实、验收依据和下一步。

## Acceptance scenarios

- [x] 在已有 `AGENTS.md` 的仓库执行公开模式安装时，保留原规则并追加带标记的 VibeCollab 入口。
- [x] 初始化完成后，`.ai-team/` 与 `.github/` 中包含公开协作、检查和 Pull Request 同步文件。
- [x] 公开模式下不生成 `.codex/hooks.json`、`.ai-team/session-policy.json` 或 `.ai-team/sessions/`。
- [x] `.ai-team/PROJECT.md` 记录本仓库真实目标、范围、架构、不变量和命令，不保留模板占位内容。
- [x] P01 的唯一写入者和 Owner 明确设置为 `dyingforge`。
- [x] 使用项目容器基线 Node.js 22 和锁文件完成 `npm ci`，并记录实际版本、退出状态及依赖树结果。
- [x] 分别执行 `npm run typecheck`、`npm run lint`、`npm test` 和 `npm run build`，即使前项失败也取得并记录后续命令的真实结果。
- [x] VibeCollab doctor、本地检查及相对 `origin/main` 的协作检查均取得实际结果并记录在本任务中。

## Invariants

- 不修改产品源码、业务行为或依赖版本；P01 只建立并记录现有工程基线。
- 不启用私有会话采集，不记录用户提交、AI 响应、密钥、内部上下文或原始命令输出。
- 不覆盖或删除工作区中已有的 `next-env.d.ts` 和 `docs/24-local-running.md` 改动；工程命令若触发生成文件变化，必须在交付前单独核对。
- 四项工程命令独立执行；失败结果不得被省略，也不得为了制造绿色结果而静默扩大任务范围。
- 工程失败若属于当前基线，记录可观察原因和后续修复入口；只有 P01 引入的回归必须在本任务中修复。

## Decisions

- 使用文档推荐的固定提交 `af6c6a4`，安装器报告版本为 VibeCollab 0.5.0。
- 目标仓库是公开仓库，因此 setup、dry-run 和验证均不传入 `--private` 或 `--private-sessions`。
- 项目长期事实以现有 `README.md`、`docs/README.md`、设计文档和 `package.json` 为依据。
- 工程基线使用本机已安装的 Node.js 22.21.1，而不是当前交互式 Shell 默认的 Node.js 24.10.0；Dockerfile 与本地运行手册均以 Node.js 22 为项目基线。
- P01 是基线刻画任务：验收要求每条命令有真实结果；若发现仓库已有失败，则记录证据和后续修复入口，不擅自修改产品实现。

## Completed

- 已确认 Git 2.39.5、Git 仓库和 Git 身份满足前置条件，本机同时存在 Node.js 22.21.1 与 24.10.0。
- 已完成公开模式 dry-run；结果无冲突，计划创建 7 个文件并追加 `AGENTS.md`。
- 已完成公开模式正式安装；安装器初始验证有效，Private Session 为禁用状态。
- 已用仓库真实信息补全 `.ai-team/PROJECT.md`，并将当前任务扩展为完整 P01 工程基线契约。
- 已将 P01 Status 设为 `active`、Owner 设为唯一写入者 `dyingforge`。
- 已在 Node.js 22.21.1、npm 10.9.4 下通过锁文件完成 `npm ci`；安装 606 个包并审计 607 个包，未改动 `package.json` 或 `package-lock.json`。
- 已取得四项工程门禁的真实基线：lint 通过；typecheck、test 和 build 的现有失败已按可观察原因记录在 Verification。
- 已复核工程命令前后的 `next-env.d.ts` 与 `docs/24-local-running.md` SHA-256，二者均未被本轮命令改变。
- 已重新运行 VibeCollab doctor、本地检查和相对 `origin/main` 的检查，三项均验证协作上下文有效且 Private Session 禁用。

## Pending

- typecheck 与 build 均因任务交付物的 3 个 Route 模块缺失而失败；该产品实现缺口不在 P01 基线刻画范围内。
- 完整测试仍有 5 项失败及 1 个测试文件无法加载：4 项 Firecracker 测试在 macOS 根目录创建 socket 临时目录时遇到只读文件系统，1 项 PI ResourceLoader 测试在 POSIX 环境处理 Windows 路径时断言失败，集成测试因上述 Route 缺失而无法加载。
- `npm ci` 报告 1 个 moderate、1 个 high 漏洞；P01 未运行自动修复或升级依赖。`npm ls --depth=0` 退出成功，但报告 2 个原生/wasm 可选依赖为 extraneous。
- P02 已指定由 `917135271` 接手；上述工程基线风险需由 P02 或后续独立修复任务继续处置。

## Next step

`917135271` 在 P01 合并后拉取最新 `main`，运行 `node .ai-team/check.mjs --base origin/main`，创建 P02 分支，将当前任务更新为 P02/active，并决定将缺失任务交付物 Route、跨平台 PI 测试失败及 npm audit 风险纳入 P02 还是独立修复任务。

## Verification

- [x] `npm ci` — Node.js 22.21.1 / npm 10.9.4；exit 0；added 606 packages、audited 607 packages；报告 1 moderate 与 1 high vulnerability；锁文件无变化
- [x] `npm ls --depth=0` — exit 0；顶层依赖可解析；`@emnapi/runtime` 与 `@img/sharp-wasm32` 被报告为 extraneous
- [x] `npm run typecheck` — exit 1；`tests/integration/task-command-api.test.ts` 引用的 artifacts、artifacts/[id]、artifacts/[id]/versions 三个 Route 模块缺失
- [x] `npm run lint` — exit 0；ESLint 无错误输出
- [x] `npm test` — 沙箱外复验 exit 1；127 个 Test Files 中 116 passed、3 failed、8 skipped；464 个 Tests 中 433 passed、5 failed、26 skipped；另有 1 个缺失 Route 的 suite 无法加载
- [x] `npm run build` — exit 1；Next.js 16.3.0 编译成功，TypeScript 阶段因同一组 3 个 Route 模块缺失而失败
- [x] `npx --yes github:dyingforge/vibecollab#af6c6a4 doctor --json` — 交接前复验 exit 0；`ok: true`，P01/handoff、Owner `dyingforge`、Next owner `917135271` 有效，Private Hook 与 Private Session 均未启用
- [x] `node .ai-team/check.mjs` — 交接前复验 exit 0；`Result: valid`，P01 handoff、functional progress 8/8，Private Session disabled
- [x] `node .ai-team/check.mjs --base origin/main` — 交接前复验 exit 0；`Result: valid`，相对 `origin/main` 的协作上下文有效，Private Session disabled

## Handoff note

- From: `dyingforge`
- To: `917135271`
- Summary: P01 已由 `dyingforge` 完成 Node.js 22 工程基线刻画并进入 handoff；依赖安装、四项工程门禁和 VibeCollab 检查均有实际结果。现有类型、构建、跨平台测试及依赖审计风险已记录，由 `917135271` 在 P02 接续处理。
