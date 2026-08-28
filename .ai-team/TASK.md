# Current Task

- ID: `P07`
- Title: `企业协作平台集成验证与回调可靠性补强`
- Status: `handoff`
- Owner: `P07`
- Next owner: `P08`

## Goal

梳理并验证企业微信、飞书和钉钉统一 Connector 的协议安全、可信租户绑定、外部身份映射、事件幂等及通知投递能力；补强合法 HTTP 回调在跨请求和并发重投时的持久化防重放语义，并分别记录本地、模拟或测试环境及真实平台联调证据。

## Acceptance scenarios

- [x] 三平台统一 Connector、能力矩阵、HTTP/Stream 差异和运行调用链已梳理并与设计契约一致。
- [x] 飞书、钉钉和企业微信的签名、时间窗、Verification Token/ReceiveId、消息解密和安全 ACK 均具备自动化证据。
- [x] 回调只使用服务端已有的租户、连接、平台和 Secret 绑定；外部身份只有在同范围内为 `verified` 时才可进入当前权限上下文。
- [x] 合法回调的重复和并发投递只产生一次持久化接收，重复回调仍返回平台成功 ACK；业务 Inbox 幂等继续作为独立保护层。
- [x] 测试通知的预检、短时提案、人工确认与结果记录，以及业务通知的全局去重、限流重试、失败和未知结果状态均完成验证。
- [x] 本地验证、模拟或测试环境验证、外部真实平台验证状态已分开记录；聚焦测试和仓库门禁已如实执行。

## Invariants

- 租户、连接、平台、操作者和权限均由服务端可信记录解析；请求中的 `tenant_id` 只作为兼容路由提示，不能成为授权事实。
- 回调必须先校验连接绑定、时间窗、签名、Token/ReceiveId 和密文，再持久化 replay 摘要；无效请求不得占用 replay 或 Inbox 状态。
- 合法重复回调返回平台要求的成功 ACK，但不得重复写入 Inbox 或触发业务副作用。
- Callback replay 与业务事件 Inbox 幂等职责分离；前者识别同一传输回调，后者识别同一标准化业务事件。
- 外部身份的 `candidate`、`conflict`、`not_found` 和 `revoked` 状态全部失败关闭；映射成功后仍重新解析内部用户的当前权限。
- 通知的 `delivered`、`retry_scheduled`、`failed` 和 `unknown` 必须持久化；未知结果停止自动重试并等待人工核对。
- 数据库变更必须提供前向迁移、兼容和回退说明，继续使用强制 RLS，不保存回调正文、解密正文或任何 Secret。
- 不修改 Pi Agent、任务指挥中心、通用 Agent 编排或其他成员负责的业务模块；不伪造真实平台验证结果。

## Decisions

- P06 已由 PR #5 合并为提交 `0f6ca30`；任务仓库随后合入原始仓库提交，P07 从 `main` 的 `4c3216c` 创建分支，现按仓库约定命名为 `codex/p07-enterprise-collaboration-integration`。
- 保留现有回调 URL 的 `tenant_id` 兼容性，本轮通过数据库连接组合匹配、失败关闭及使用连接记录中的可信 tenant 继续处理来证明绑定，不引入绕过 RLS 的全局连接查询。
- 合法 duplicate 属于幂等结果，不属于认证失败：飞书、钉钉和企业微信继续收到各自协议要求的成功 ACK。
- 在 `WebhookIngressService.receive()` seam 验证回调行为，在 replay store interface 验证持久化原子性；数据库测试使用 PGlite，只有三方平台网络使用 mock adapter。
- Replay fingerprint 由服务端根据版本、平台、连接、平台时间戳、nonce、签名和原始正文摘要计算；只在协议校验成功后 claim，数据库不保存原文。
- 复用 `0004_connector_platform.sql` 已有的 `webhook_replay_claims`、过期索引和强制 RLS，不新增或修改 Schema；P07 只补齐此前缺失的应用 adapter、运行时接线与自动化证据。
- 采用 red → green 垂直切片：先复现两个独立 `receive()` 调用的重复投递，再实现最小内存 adapter，随后接入既有 PostgreSQL replay 表并增加并发/隔离证据。
- 公开仓库继续禁用 VibeCollab Private Session；不存在 `.ai-team/session-policy.json` 时不得声称已采集私有会话证据。

## Completed

- 已确认 P06 实际合并状态与过期 TASK Pending 的差异；当前 P07 基线 `4c3216c` 与 `main`、`origin/main` 一致，接棒前工作区 clean。
- 已创建、检出并推送分支 `codex/p07-enterprise-collaboration-integration`；旧的中文远端分支名已移除，提交历史保持不变。
- 已阅读 AGENTS、PROJECT、TASK、共享协作规范、连接器设计及当前 Next.js Route Handler 指南，并确认 P07 测试 seam。
- 已执行 `npm ci`；按 lockfile 安装 610 个包并审计 611 个包，报告 1 个 moderate 和 1 个 high 既有依赖问题，未执行自动修复。
- 已梳理统一 Connector、三平台 verifier/normalizer、Webhook ingress、外部身份 control plane、Inbox、通知路由和接入验收控制面。
- P07 初始聚焦基线共 11 个测试文件、45 项测试通过；现有测试尚未覆盖两个独立 ingress 调用或并发进程请求的持久 replay claim。
- 已新增 callback replay interface、内存与 PostgreSQL adapters，并在真实 Route Handler 中接入 `0004` 已有的租户隔离 replay 表；fingerprint 只保存协议字段和正文摘要。
- 已修复跨请求/多实例重复回调：三平台合法 duplicate 保持成功 ACK，并通过稳定首次接收时间使无平台 event ID 的事件仍获得确定性 Inbox 幂等。
- 已覆盖 replay 已落库但 Inbox 首次失败的崩溃窗口：平台重试会继续尝试 Inbox，只有 Inbox 已存在时才报告 duplicate，避免事件丢失。
- 已验证 PostgreSQL 并发 claim 只有一个 accepted、过期摘要可清理、duplicate 返回首次接收时间，且租户/连接/平台绑定精确匹配。
- 已补齐 `candidate`、`conflict`、`not_found` 和 `revoked` 外部身份失败关闭证据；真实 Worker 回归证明 verified 用户仍从权威库重新解析当前权限后执行渠道动作。
- 已回归测试通知的预检、短时提案、同一管理员确认、收件人摘要和 unknown 停止重试，以及业务通知去重、429 重试、可靠回执与主渠道明确失败后的备用渠道降级。
- 已同步连接器、安全、事件契约和需求追踪文档，明确 HTTP replay 与业务 Inbox 幂等的职责及失败恢复顺序。
- P07 最终聚焦回归共 15 个测试文件、78 项通过；Lint 与差异检查通过，生产构建完成代码编译后仅被已知范围外类型基线阻断。

## Pending

- 外部真实平台验证：当前没有飞书、钉钉和企业微信测试企业、应用凭据、受管 Secret 或可审计联调窗口，三平台安装、身份、事件、消息和故障恢复联调均为 `blocked`；本轮没有将本地 fixture 或 PGlite 结果冒充外部通过。
- 全仓 `typecheck` 和 `build` 仍被上游合并后的 3 个 Task Command Artifact Route 缺失及 3 个 `agent-native-tool-routing` 调用参数错误阻断；P07 代码编译和聚焦测试未出现错误，相关基线由对应成员或 P10 汇总处理。
- `npm ci` 报告 1 moderate、1 high 既有依赖审计问题，未执行可能改变依赖行为的自动修复。
- P07 提交和 PR 合并后由 P08 接棒；P10 最终在具备稳定全仓环境和外部 Gate 证据时执行全量回归。

## Next step

P08 从 `app/api/agent/route.ts`、`app/api/v1/agent` 和 `src/modules/agent` 的请求入口开始，使用 P07 已验证的可信租户、外部身份和当前权限上下文，梳理模型网关、Tool/Skill Registry、经营管理查询工具、异常结果及 R3 提案人工确认链路；保持 Pi Agent 专项在范围外。

## Verification

- [x] `npm ci`：exit 0；安装 610 个包，审计 611 个包；报告 1 moderate、1 high，未自动修复。
- [x] P07 初始聚焦回归：exit 0；11 个测试文件、45 项通过。
- [x] `node .ai-team/check.mjs --base origin/main`（接棒前）：exit 0，P06 handoff valid、Private sessions disabled。
- [x] `node .ai-team/session.mjs validate`（接棒前）：exit 0，`enabled: false`、无错误。
- [x] P07 replay/安全/身份/通知聚焦回归：exit 0；15 个测试文件、78 项通过，包含本地 fixture、Route/application 模拟、PGlite/PostgreSQL adapter 和真实 Worker 路径。
- [x] `npm run typecheck`：exit 1；仅报告 3 个 Task Command Artifact Route 缺失和 3 个 `agent-native-tool-routing` 参数错误，未报告 P07 文件错误。
- [x] `npm run lint`：exit 0。
- [x] `npm run build`：exit 1；Next.js 生产代码编译成功，TypeScript 阶段被与 typecheck 相同的 6 个范围外基线错误阻断。
- [x] `git diff --check`：exit 0；仅输出仓库行尾转换提示，无空白错误。
- [x] 本地验证：三平台加密 fixture、replay/Inbox 故障恢复、身份状态、通知状态与需求追踪通过。
- [x] 模拟或测试环境验证：PGlite replay 原子 claim/RLS 兼容、接入验收仓储、Worker 当前权限解析和通知持久化通过。
- [x] 外部真实环境验证：`blocked`；缺少三平台测试企业、凭据、受管 Secret 和联调窗口，未执行真实消息副作用。
- [x] `node .ai-team/check.mjs --base origin/main`：exit 0；P07 handoff、6/6 验收、Private sessions disabled，结果 valid。
- [x] `node .ai-team/session.mjs validate`：exit 0，`enabled: false`、无错误；不是 Private Session 验收。
- [x] `node .ai-team/session.mjs report`：exit 0；0 个 session，Private sessions disabled。

## Handoff note

- From: `P07`
- To: `P08`
- Summary: P07 已完成三平台统一 Connector、协议安全、可信绑定、外部身份、事件幂等与通知状态验收，并把既有 PostgreSQL replay 表接入真实回调入口。跨请求和并发 duplicate 返回安全 ACK 且只保留一个 Inbox 事件；replay 与 Inbox 之间的失败窗口可恢复。聚焦 78 项测试、Lint 和代码编译通过，6 个全仓类型基线错误及真实三平台联调 blocked 已如实记录。P08 从通用 Agent 请求入口继续验证上下文、工具和确认机制。
