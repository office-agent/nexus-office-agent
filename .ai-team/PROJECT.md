# Project Context

This file contains stable facts shared by every developer and AI. Change it only when the project direction or architecture changes.

## Goal

交付一个面向企业团队的 AI 原生统一办公与管理平台，以“目标 → 项目 → 风险/问题 → 决策 → 行动 → 证据”为业务主线，让网页、飞书、钉钉、企业微信及后续自建客户端共享同一套业务事实、权限、Agent 工具和审计内核。

## Scope

- In scope: 响应式工作台与工作指挥中枢、企业管理领域模型、权限与审计、持久化工作流、Agent Skill/Tool 路由、知识与管理智能、飞书/钉钉/企业微信连接器、PostgreSQL 持久化、部署运维和可安装客户端能力。
- In scope: 公开仓库中的通用源码、自动化测试、设计文档、脱敏交接材料和本地/生产工程门禁。
- Out of scope: 内部项目台账、真实企业配置或数据、密钥、运行产物，以及必须依赖真实 IdP、平台测试企业、灾备演练或长期试点才能取得的外部验收证据。
- Out of scope: 绕过人工确认执行高风险动作，或以 Agent 输出替代权威业务事实、测试和 CI 证据。

## Architecture

- `app/` 和 `components/`：Next.js 页面、Route Handler 与响应式交互入口。
- `src/modules/`：按业务域组织的模块化单体；领域规则、用例、端口和仓储实现由对应模块拥有。
- `src/platform/`：数据库、HTTP、身份、安全、Secret、可观测性、运行上下文与 Worker 等共享基础设施。
- `scripts/`：迁移、Worker、PI Runtime、备份恢复和运维检查入口；`tests/`：单元、集成、性能与验收证据。
- `docs/03-domain-and-data-model.md`、`docs/04-technical-architecture.md`、`docs/05-agent-platform.md`、`docs/07-security-and-permissions.md` 和 `docs/08-api-and-event-contracts.md` 分别是领域、架构、Agent、安全和接口契约的主要设计依据；`docs/15-requirement-traceability.md` 维护需求到测试的追踪关系。
- PostgreSQL Schema、RLS、状态机、权限层和 Tool Registry 是服务端约束的权威实现；外部协同平台只是交互渠道和数据源，不是系统事实源。

## Invariants

- Never commit credentials, private source copies, system/developer prompts, raw tool output, keyboard activity, or chain-of-thought.
- Raw user submissions may be committed only when the repository is private and `.ai-team/session-policy.json` explicitly enables verbatim capture.
- Preserve existing behavior unless the active task explicitly changes it.
- Let tests and CI decide observable behavior.
- 公开仓库不得启用 VibeCollab 私有会话记录，不得添加 `.codex/hooks.json`、`.ai-team/session-policy.json` 或 `.ai-team/sessions/`。
- Agent 的有效权限始终是用户权限、工具权限、数据范围和场景策略的交集；业务副作用只能通过 Tool Registry，所有高风险动作必须持久化并由人明确确认。
- 文档、模型输出和外部事件均视为不可信输入；生产身份、租户隔离、审计历史和 Secret 边界不得降级。
- 影响业务语义、权限、外部协议或验收口径的变更必须同步更新权威文档和追踪证据。

## Commands

- Install: `npm ci`
- Test: `npm test`
- Verify: `npm run typecheck && npm run lint && npm test && npm run build`
- Database migrations: `npm run db:migrate`
- VibeCollab: `node .ai-team/check.mjs --base origin/main`
