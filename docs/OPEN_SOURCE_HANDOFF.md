# 开源交接手册

## 1. 交接范围

本仓库是 `nexus-office-agent` 的公开工程源码快照，包含通用源码、测试、设计文档、部署模板和脱敏功能清单。它适合作为企业统一 Agent/办公平台的研究、开发和二次实现基础。

公开仓库明确不包含：

- 真实模型、数据库、OIDC、企业微信、飞书、钉钉、OpenBao、Forgejo 或对象存储凭据；
- 企业域名、云主机地址、真实租户、真实成员、生产应用编号和内部部署记录；
- `.env.local`、`.env.wecom.local`、构建输出、运行日志、测试产物和本地环境实例；
- 任何可以替代企业安全、合规和生产验收的声明。

`.project-to-act/` 项目管理账本现作为公开工程快照的一部分提交，用于记录模块、版本、验收边界和历史决策；真实凭据、企业环境配置和运行产物仍不得进入仓库。

## 2. 仓库结构

| 路径 | 用途 |
|---|---|
| `app/` | Next.js App Router 页面和 HTTP API |
| `components/` | 员工工作台、治理控制台和交互组件 |
| `src/modules/` | 企业领域、Agent、Pi Runtime、连接器和业务应用层 |
| `src/platform/` | 身份、数据库、HTTP、安全、密钥、遥测和基础设施适配 |
| `scripts/` | Runner、Worker、迁移、备份、恢复和预检脚本 |
| `tests/` | 单元、集成、迁移、API、连接器和安全测试 |
| `docs/` | 产品、架构、API、安全、测试、交付和开源文档 |
| `.project-to-act/` | 项目目标、模块、版本、验收和历史决策账本 |
| `deploy/kubernetes/nexus.yaml` | 脱敏的 Kubernetes 部署模板，必须替换镜像和环境变量 |
| `.env.example` | 变量名参考，不得填入真实值 |

## 3. 本地安装

要求：Node.js 20+、npm、现代浏览器。需要持久化数据库时另需 PostgreSQL；没有数据库时项目可使用开发适配器完成部分本地验证。

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run dev
```

访问 `http://localhost:3000`。本地演示身份只允许在明确的本机验收环境启用：

```text
NEXUS_ALLOW_DEMO_IDENTITY=true
```

真实部署必须关闭演示身份并接入 OIDC、权威授权数据库和受管密钥服务。模型、数据库和连接器凭据只能通过本地未提交环境或部署密钥管理器提供。

需要数据库时：

```bash
npm run db:migrate
```

## 4. Pi Agent 运行边界

Pi 是 Agent Runtime，不是 Web 请求处理器。正式运行路径应保持：

```text
Web/PWA → BFF/API → Agent Controller → Pi Runner → Sandbox → Tool Gateway/MCP
```

关键不变量：

1. 一个 Run 只属于一个租户、主体、Workspace、基线 Commit 和 Sandbox。
2. Pi 只接收服务端冻结的 `RunManifest`，不能自行扩大 Profile、Skill、Tool、模型、网络或数据范围。
3. Tool 必须经过 Runner 内拦截和服务端 Tool Gateway 双重校验。
4. Skill 只提供认知说明，不直接授予权限；MCP Token、Git 凭据和 Secret 不进入模型上下文。
5. R2/R3 操作必须经过持久化人工审批，并在恢复前重验对象版本和策略版本。
6. R4、未知 Tool、未知资源、缺少 scope 或基础设施不可用时必须失败关闭。
7. Sandbox 默认无公网，代码、Shell、Git 和测试只能在当前执行边界内运行。

Windows 开发机没有 Linux/KVM/Firecracker/Kata 时，执行：

```bash
npm run pi-sandbox:preflight
```

返回 `not_ready` 是正确的安全结果；Docker Desktop 不能替代微 VM 隔离证明。

## 5. 运行与验证顺序

建议新维护者按以下顺序接手：

1. 阅读 [公开功能清单](./FEATURE_CATALOG.md) 和 [设计文档索引](./README.md)。
2. 安装依赖并执行 typecheck、lint、test、build。
3. 使用无凭据的开发环境验证页面、只读 API 和内存适配器。
4. 使用隔离的测试数据库验证迁移、租户作用域和 RLS；不要连接生产数据库。
5. 检查 Runner bundle 和 Sandbox preflight，再决定是否进入 Linux/KVM 环境。
6. 接入任一真实外部依赖前，先建立租户、密钥、审计、回退和最小权限方案。
7. 任何新功能都要同步更新功能清单、API/设计文档、测试和验收证据。

## 6. 生产化前置条件

以下条件全部具备前，不应把公开仓库部署为生产 Agent 执行平台：

- OIDC/企业身份、租户与组织授权事实源；
- PostgreSQL 强制 RLS、迁移回退和审计保留策略；
- Firecracker/Kata、Guest Agent、网络代理、SSRF/Metadata 防护和逃逸测试；
- Forgejo/Git、对象存储、OCI Registry、签名、SBOM/SCA 和短期凭据；
- OpenBao 或等价密钥服务、模型 Gateway、OTel、配额和成本对账；
- 组织审批人目录、职责分离、真实审批暂停/恢复和变更交付；
- 多进程 Runner 崩溃恢复、备份恢复、RPO/RTO、轮换、灰度和回退演练；
- 真实企业连接器、外部网络、攻击矩阵和团队试点验收。

## 7. 回退原则

- 停止新 Run 和执行型 Worker 领取，保留 Session、Event、Audit、Git Diff 和 Artifact 事实。
- 撤销短期凭据、MCP/Tool capability 和外部连接；不自动重放未知副作用。
- 高风险审批、发布、合并、外发和生产部署回到人工处理或只读提案。
- 版本回退必须保留数据库向前兼容窗口和历史审计，不删除事实记录。

## 8. 开源维护要求

- 不提交任何 `.env*` 实例文件、密钥、Token、个人信息、生产 URL、云主机信息或原始企业数据。
- 测试使用虚构租户、用户、域名和凭据；真实环境只在受控测试仓库或私有配置中验证。
- 修改权限、数据模型、Tool、MCP、审批、Runner 或 Sandbox 时，必须补充测试和安全边界说明。
- 公开声明只能基于可复核的测试和证据；本地控制面通过不等于生产 Gate 通过。
- 详见 [贡献指南](../CONTRIBUTING.md) 和 [安全策略](../SECURITY.md)。
