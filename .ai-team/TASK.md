# Current Task

- ID: `P02`
- Title: `身份、权限、多租户与客户端平台验证`
- Status: `handoff`
- Owner: `917135271`
- Next owner: `P03`

## Goal

梳理并验证 Nexus Office Agent 的服务端身份解析、租户隔离、授权策略、数据库访问边界和客户端安全链路，补强一项可合并的工程成果，使 Web、PWA 与业务 API 使用一致且可测试的安全上下文。本任务不包含 Pi Agent 二次开发。

## Acceptance scenarios

- [x] 梳理生产身份、开发身份和请求会话进入业务 API 的可信上下文链路。
- [x] 验证租户、角色、权限、数据范围及授权策略的核心实现与现有测试。
- [x] 验证跨租户访问、越权访问和权限撤销相关边界，明确应用层与 PostgreSQL 层的责任分工。
- [x] 验证客户端注册、PWA 安全配置及相关 API 的关键约束。
- [x] 完成至少一项身份、权限或客户端平台工程改进，并补充可复现测试。
- [x] 相关测试、Lint 和 VibeCollab 协作检查取得真实结果并记录。

## Invariants

- 身份、租户与权限结论必须来自服务端可信上下文，不接受客户端自行声明的高权限事实。
- 有效权限保持为用户权限、工具权限、数据范围和场景策略的交集。
- 不削弱租户隔离、RLS、审计、高风险动作人工确认或 Secret 边界。
- 不修改 Pi Agent、Firecracker 或 Pi ResourceLoader 相关实现和测试。
- 不为处理 P01 已记录的其他模块基线失败而扩大 P02 范围；若其阻塞 P02 验证，只记录可观察证据。
- 公开仓库继续禁用 VibeCollab 私有会话记录，不提交密钥、真实企业配置或运行产物。

## Decisions

- P02 从已合并的 `origin/main` 创建独立分支 `codex/p02-identity-access-client-platform`。
- 主要代码范围为 `src/platform/identity`、`src/modules/identity`、`src/modules/authorization`、`src/modules/client-platform` 及对应 API 和测试。
- 先依据真实代码和测试确定工程缺口，再实施最小可验证改进；不预设需要修改数据库 Schema 或公共接口。
- P01 记录的 Artifact Route 缺失、Pi 跨平台测试失败和依赖审计风险保留为项目基线事实，不作为 P02 默认修复项。
- 客户端能力以服务端保存的设备版本、信任等级和当前策略共同决定；请求参数中的版本仅用于尚未登记设备的兼容性提示，不能覆盖已登记设备事实。
- 最低版本或受管设备策略变化后，Bootstrap 与推送订阅都重新执行当前策略校验；设备重新登记时保留服务端维护的信任等级。

## Completed

- 已从团队仓库最新 `origin/main` 接受 P01 交接，交接提交为 `dc4253b1`。
- 已确认 P01 的 `Status: handoff`、`Next owner: 917135271`，且主分支协作检查结果为 `valid`。
- 已创建 P02 独立分支并将当前任务切换为 P02/active，唯一写入者为 `917135271`。
- 已确认生产请求只从签名 Session 取得租户和主体线索，并在每次请求中通过 PostgreSQL 授权解析器重新读取有效用户、角色、权限和数据范围；会话内旧授权及客户端身份 Header 不参与生产授权。
- 已确认授权策略先校验租户、操作权限和数据范围，再校验字段范围及 Agent 工具权限；跨租户、范围外访问、离职用户和到期角色均有自动化测试。
- 已确认客户端注册 Schema 拒绝客户端自报租户、用户和信任等级；设备仓储按租户和用户查询，PWA 不缓存 API/业务导航，推送订阅敏感数据采用绑定租户、用户和设备上下文的加密信封。
- 已修复客户端当前策略重校验缺口：已登记设备不再通过请求自报高版本绕过最低版本判断，推送订阅会重新校验当前版本和受管设备要求，可信设备重新登记时可按当前策略恢复 active。
- 已新增策略升级回归测试，覆盖最低版本上调、受管设备要求启用、推送拒绝和可信设备重新登记。
- 已创建 PR `#1`，P02 代码、测试和 `.ai-team/TASK.md` 保持在同一交付分支，GitHub `repo-task-sync` 检查通过。

## Pending

- 真实企业 OIDC、MFA、用户停用同步、受管设备证明和真实推送服务仍需在外部测试环境验证，本地自动化只验证代码契约。
- 全仓库 TypeScript 检查仍被 P01 已记录的 3 个 Artifact Route 模块缺失阻塞；本轮 P02 变更未新增类型错误。
- P03 接续经营管理闭环验证；P02 的外部环境 Gate 和全仓库基线问题不作为 P03 的默认修复范围。

## Next step

P03 拉取最新 `main`，运行 `node .ai-team/check.mjs --base origin/main` 验收交接，创建 `codex/p03-management-loop` 分支，将当前任务更新为 P03/active；随后从 `src/modules/management-loop` 和相关 API、测试开始，验证目标、项目、风险/问题、决策、行动与证据的业务闭环。

## Verification

- [x] `npm ci` — Node.js 24.14.0 / npm 11.9.0；exit 0；按锁文件安装 612 个包，报告 1 moderate 与 1 high 基线漏洞，锁文件无变化
- [x] P02 修改前相关基线 — Node.js 22.22.2；7 个测试文件、25 项测试全部通过
- [x] P02 修改后相关回归 — Node.js 22.22.2；8 个测试文件、29 项测试全部通过
- [x] `npm run lint` — Node.js 22.22.2；exit 0
- [x] `npm run typecheck` — Node.js 22.22.2；exit 1；仅报告 P01 已记录的 3 个 Artifact Route 模块缺失
- [x] `node .ai-team/check.mjs --base origin/main` — Node.js 22.22.2；exit 0；P02 functional progress 6/6，Result: valid，Private Session disabled

## Handoff note

- From: `917135271`
- To: `P03`
- Summary: P02 已完成身份、权限、多租户与客户端平台审计，补强客户端当前策略重校验并通过相关测试、Lint、VibeCollab 与 GitHub 协作检查；P03 可从最新 main 创建独立分支，开始经营管理闭环验证。
