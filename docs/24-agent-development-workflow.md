# Agent 开发工作流

> 状态：本地实现
> 适用对象：技术负责人、需求交接人、开发者、测试人员、交付审核人
> 核心原则：先留档、再开发；版本有差异、功能有清单；测试通过后才能交付。

## 1. 模块目标

“Agent 开发”是统一办公平台中的独立研发治理模块。它不替代 Git、CI 或项目协作工具，而是在平台内建立一条可审计的工作流：把需求交接转成 `project-to-act` 的五份权威文档，保留主要版本的 Git 差异和功能清单，把功能测试绑定到具体版本，并在交付前由服务端逐项校验材料完整性。

模块管理以下五份固定文档，文档路径不可由客户端任意指定：

- `.project-to-act/PROJECT_OVERVIEW.md`
- `.project-to-act/PROJECT_PROGRESS.md`
- `.project-to-act/PROJECT_FEATURES.md`
- `.project-to-act/PROJECT_VERSIONS.md`
- `.project-to-act/PROJECT_ACCEPTANCE.md`

## 2. 四段式门禁

| 阶段 | 必须提交 | 服务端门禁 | 通过后的状态 |
|---|---|---|---|
| 需求交接 | 项目名称、需求说明、验收标准、仓库和目标分支 | 原子生成并留档全部五份文档；缺少任一文档即失败 | `requirements_archived` |
| 版本开发 | 版本号、起止 Git SHA、完整 diff、功能清单 | 需求尚未留档时拒绝；每个主要版本必须同时有 diff 与功能 | `in_development` |
| 功能测试 | 版本、测试名称、预期、实际结果、证据、通过/失败结论 | 测试必须绑定已有版本；失败结果保留但不能用于交付放行 | `testing` 或 `ready_to_deliver` |
| 交付冻结 | 当前项目版本号 | 每个主要版本都必须有 diff、功能清单和至少一项已通过的功能测试 | `delivered` |

所有写操作要求 `Idempotency-Key` 和 `If-Match`。`If-Match` 使用项目的 `projectVersion`，并发修改发生版本冲突时返回 `409`，避免覆盖他人刚刚留档的进度。

## 3. 交付物

交付成功后，平台冻结一个不可变交付记录，包含：

- 最新修订的五份 `project-to-act` 文档及其 SHA-256 摘要；
- 每个主要版本的版本号、起止 Git SHA、diff 摘要、功能清单和内容摘要；
- 与版本一一关联的功能测试、预期/实际结果、测试证据和证据摘要；
- 汇总以上材料的交付清单摘要 `manifestDigest`。

界面和普通读取接口只返回 diff 节选与字节数，不把完整源码差异散布到列表视图；完整 diff 仍由服务端作为版本证据保存。

## 4. Skill 建议

模块按阶段给出 Skill 建议，但 Skill 不会绕过权限、版本或证据门禁。

| Skill | 使用时机 | 作用 |
|---|---|---|
| `project-to-act` | 需求交接、进度更新、交付冻结 | 维护五份项目权威文档，是必选 Skill |
| `repo-task-sync` | 多人或多 Agent 接力开发 | 同步仓库任务、提交、PR、CI 与交接证据 |
| `llm-api-config` | Agent 接入模型或 Embedding | 安全接入模型配置，避免密钥进入源码和交付物 |
| `ui-design` | 新增或重构交互界面 | 形成可用、可验收的产品界面 |
| `aawo-agent-tester` | Agent 功能测试与回归 | 通过真实边界、证据账本和失败关闭行为验收 Agent |
| `agentops-awesome-list` | 测试完成后、交付前的 Agent 健康检查 | 按实际复杂度执行只读检查，识别架构缺口、功能风险与优化建议；不修改项目，也不替代功能测试 |
| `avoid-overkill` | 方案、实现、测试和文档复核 | 控制范围，避免无证据扩张和无关复杂度 |

## 5. 接口与权限

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/v1/agent-development/projects` | `GET` | `agent_development:read` | 读取当前租户项目快照 |
| `/api/v1/agent-development/projects` | `POST` | `agent_development:write` | 完成需求交接并留档五份文档 |
| `/api/v1/agent-development/projects/{id}/versions` | `POST` | `agent_development:write` | 保存主要版本、Git diff 与功能清单 |
| `/api/v1/agent-development/projects/{id}/tests` | `POST` | `agent_development:write` | 保存绑定版本的功能测试与证据 |
| `/api/v1/agent-development/projects/{id}/delivery` | `POST` | `agent_development:deliver` | 校验并冻结完整交付清单 |

迁移 `0044_agent_development_workflow.sql` 创建三项权限，但不会替生产角色自动授权。生产管理员必须根据职责分离原则显式配置 `role_permissions`；尤其是 `agent_development:deliver`，不应默认授予所有开发者。

## 6. 数据、安全与运行边界

- 项目、文档、版本、测试和交付记录均携带 `tenant_id`，数据库表启用并强制 PostgreSQL RLS。
- 五类写入均由数据库触发器在同一事务中追加审计事件。
- 客户端提交的 `createdBy`、租户信息、摘要和状态不被信任，身份与摘要由服务端计算。
- 无 `DATABASE_URL` 时使用进程内开发仓储，适合本地界面和测试，不构成持久化或生产就绪证明。
- 生产能力仍取决于真实 IdP、角色授权、PostgreSQL 迁移、备份恢复和运行环境验收。

## 7. 本地验收

模块的自动化验收覆盖：五文档一次性留档、幂等重放、并发版本冲突、未满足材料时失败关闭、完整交付清单、API 响应脱敏、迁移 RLS/审计合同、PostgreSQL 仓储和租户隔离。仓库级交付仍需执行：

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

浏览器验收还应分别检查宽屏和移动端的需求交接、四段门禁、版本/测试录入、交付拒绝与交付成功路径。
