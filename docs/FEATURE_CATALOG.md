# 公开功能清单

更新时间：2026-08-26
项目：Nexus Office Agent / 枢纽统一办公平台 Agent
公开版本基线：`0.14.0-work-command-center`

本文是公开仓库的功能快照。它描述源码中已经存在的本地控制面和适配器，不把本地测试、模拟依赖或设计合同写成生产能力。企业环境、生产地址、真实凭据、内部部署证据和原始项目台账不属于公开发布范围。

状态含义：

- **本地实现**：源码和本地测试已覆盖，适合开发、审查和二次开发。
- **控制面实现**：接口、状态机或适配器已实现，但依赖真实外部基础设施才能完成验收。
- **外部 Gate 待完成**：代码保留安全边界并默认失败关闭，不能据此宣称生产可用。

## 功能总表

| 模块 | 公开源码范围 | 当前状态 | 主要边界 |
|---|---|---|---|
| 企业工作台 | `app/`、`components/` | 本地实现 | 浏览器只负责对话、视图和交互，不持有模型、Git 或企业凭据 |
| 工作指挥中枢 | `components/pi-coding-workbench.tsx`、`src/modules/task-command/` | 本地实现 | 任务拆包、分派、承接、状态和证据均受服务端权限约束 |
| Agent 开发 | `components/agent-development-workflow.tsx`、`src/modules/agent-development/` | 本地实现 | 需求五文档留档后才开放开发；主要版本必须保留 diff、功能清单和通过的功能测试才能交付 |
| 企业领域模型 | `src/modules/`、`src/platform/` | 本地实现 | 目标、项目、任务、风险、问题、决策、行动和证据共享租户上下文 |
| 身份与多租户 | `src/platform/identity/`、`src/platform/context/`、数据库 RLS 迁移 | 控制面实现 | 生产必须接入权威 IdP、PostgreSQL RLS 和组织授权事实源 |
| Agent Runtime | `src/modules/pi-agent/`、`scripts/build-pi-runner.mjs` | 控制面实现 | Pi 在独立 Runner 设计中运行，Web 进程不直接执行 Pi |
| Pi Session/Tree | Session、Branch、Fork、Resume、Compact、事件流接口 | 本地实现 | 跨进程、生产队列和真实 Runner 恢复仍需外部 Gate |
| Agent Profile | coding、review、debug、refactor、office、integration、release | 本地实现 | Profile 只缩小能力范围，不直接授予企业权限 |
| Skill/Package/Extension | Resource Registry、签名摘要、快照、撤销和受控 ResourceLoader | 控制面实现 | 未批准资源、未知仓库扩展和运行时公网安装默认拒绝 |
| MCP Bridge | MCP Registry、Binding、Schema、Session/Run scope、调用审计 | 控制面实现 | 真实 MCP、OpenBao、OAuth、出口代理和攻击矩阵尚未完成 |
| Tool Gateway | 工具注册、风险分级、服务端二次授权、审计、熔断 | 控制面实现 | Pi 内部 Hook 不是最终权限边界，Gateway 不可用时失败关闭 |
| Approval Gateway | R2/R3 审批提案、TTL、对象版本重验、拒绝/撤销/中断分流 | 本地实现 | 组织审批人目录和真实高风险 Tool pause/resume 尚未完成 |
| Change Delivery | 变更集、临时分支、Commit、PR/Merge/Release Proposal、CAS 和未知终态 | 控制面实现 | 真实 Forgejo、发布目标、持久 Outbox 和生产合并仍未验收 |
| Workspace/Artifact | Workspace、Git scope、Checkpoint、Diff、Artifact 元数据和下载授权 | 控制面实现 | 真实 Forgejo/S3、短期凭据和隔离执行环境尚未接入 |
| Sandbox | Provider、Supervisor、Run Token、Guest Agent 和默认拒绝出站策略 | 外部 Gate 待完成 | 需要 Linux/KVM、Firecracker/Kata、vhost-vsock、cgroup、rootfs 和安全代理 |
| Model Gateway | Provider 路由、数据分类、策略、成本、用量、配额和评测 | 控制面实现 | 真实私有模型、生产配额账本、OTel 和密钥服务尚未验收 |
| 安全与韧性 | Kill Switch、不可变安全事件、容量租约、恢复/回退摘要、FailClosed Probe | 本地实现 | 生产灾备、轮换、跨进程故障、SSRF/DNS/Metadata 和红队验证仍待完成 |
| 连接器 | 飞书、钉钉、企业微信的统一事件、签名、加密、回执和幂等适配 | 控制面实现 | 真实企业、可信出口、HTTPS 回调和端到端消息旅程需单独验收 |
| 运营与治理 | Readiness、Pilot、Release Gate、风险、灰度、撤销和运营摘要 | 控制面实现 | 本地 Gate 不等于真实生产发布或四周团队试点 |

## 已覆盖的本地验证

- `npm test`：单元、迁移、仓储、API、连接器和 Agent 控制面测试。
- `npm run typecheck`：TypeScript 类型检查。
- `npm run lint`：ESLint 检查。
- `npm run build`：Next.js 生产构建。
- `npm run pi-runner:bundle`：独立 Pi Runner 制品构建。
- `npm run pi-sandbox:preflight`：沙盒前置条件检查；在没有 Linux/KVM 的开发机上应保持 `not_ready`，不能伪造通过。

## 当前明确未完成的生产 Gate

公开源码不能替代以下真实环境验证：

1. Firecracker/Kata 微 VM、Guest Agent、seccomp/capability、cgroup、vhost-vsock 和沙盒逃逸测试。
2. Forgejo/Git、对象存储、OCI Registry、签名、SBOM/SCA、制品撤销传播和短期凭据。
3. OpenBao、真实 MCP Server、OAuth、受控出站代理、SSRF/DNS Rebinding/Metadata 攻击矩阵。
4. 真实 IdP、组织审批人、PostgreSQL 强制 RLS、生产模型、OTel、配额和成本对账。
5. 多进程 Runner 崩溃恢复、真实审批暂停/恢复、PR/合并/发布和生产回退。
6. 连续就绪、RPO/RTO、灾备与密钥轮换，以及真实团队试点和发布委员会验收。

## 相关文档

- [设计文档索引](./README.md)
- [开源交接手册](./OPEN_SOURCE_HANDOFF.md)
- [Agent Runtime 设计](./23-pi-agent-enterprise-runtime.md)
- [Agent 开发工作流](./24-agent-development-workflow.md)
- [安全与权限](./07-security-and-permissions.md)
- [测试与验收](./09-testing-and-acceptance.md)
- [需求追踪](./15-requirement-traceability.md)
