# 本地运行手册

## 适用范围

本文用于在开发机上启动网页、业务 Agent 和可选的 PostgreSQL，并验证真实模型调用。默认不启动 PI Runner、PI Sandbox 或 PI Workspace Supervisor；这些进程不是办公业务层本地预览的前置条件。

## 1. 准备环境

- Node.js 22（与项目容器基线一致）和 npm。
- 一个可调用 OpenAI Chat Completions API 的服务端 API Key。
- 可选：PostgreSQL。未配置数据库时，开发环境使用内存仓储，重启后数据会清空。

首次安装依赖：

```bash
npm ci
```

## 2. 配置真实模型

复制示例文件，并只在本机未跟踪的 `.env.local` 中填写真实凭据：

```bash
cp .env.example .env.local
```

开发预览所需的最小配置如下：

```dotenv
NEXUS_ALLOW_DEMO_IDENTITY=true
NEXUS_MODEL_MODE=enabled
OPENAI_API_KEY=<仅在本机填写，不要提交或发送到聊天中>
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.6
PUBLIC_APP_ORIGIN=http://localhost:3000
```

注意：

- `.env.local` 已被 `.gitignore` 排除；不要把真实 Key 写入 `.env.example`、源码、文档或提交记录。
- `OPENAI_BASE_URL` 是 API 根地址。业务 Agent 会在它后面追加 `/chat/completions`，不要把该路径重复写入变量。
- 使用兼容网关时，替换 `OPENAI_BASE_URL`、`OPENAI_MODEL` 和对应 Key 即可；也可使用同义变量 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`。
- 模型名必须是当前账户或兼容网关实际开放的模型。仓库示例默认使用 `gpt-5.6`。
- API Key 是服务端 Secret，不能放入 `NEXT_PUBLIC_*` 变量，也不能嵌入浏览器代码。

## 3. 启动开发环境

```bash
npm run dev
```

打开：

- 工作对话：`http://localhost:3000/?view=command`
- 存活检查：`http://localhost:3000/api/v1/health`
- 运行状态：`http://localhost:3000/api/v1/operations/status`

开发环境的 `/api/v1/ready` 会检查生产级门禁，可能因未配置 OIDC、Secret Manager、WAF、备份等返回 503；这不等同于本地开发启动失败。局域网模式应按 [局域网本地部署](./23-lan-deployment.md) 的标准检查 readiness。

## 4. 验证真实模型

在“工作对话”中发送一个不会产生高风险副作用的请求，例如：

> 把“准备下周项目复盘”拆成三个可验收任务，并说明每项完成证据。

确认：

1. 页面收到模型生成的自然语言响应，而不是 `MODEL_UNAVAILABLE`。
2. 响应中显示实际 Skill/Tool 路线；涉及写操作时仍遵守权限、确认和状态机约束。
3. 服务端日志没有 401、403、404 或模型网关错误，且没有打印 API Key。

## 5. 可选：只为办公业务层启用 PostgreSQL

在 `.env.local` 增加：

```dotenv
DATABASE_URL=postgres://nexus:<local-password>@127.0.0.1:5432/nexus
```

当前迁移 `0001–0023` 覆盖共享基础设施与办公业务层；`0024–0042` 是 PI Agent 运行时。只开发非 PI 部分时执行：

```bash
npm run db:migrate -- --through 0023_work_artifact_evidence_chain
```

只有需要完整 PI 运行时时才执行全部迁移：

```bash
npm run db:migrate
```

不配置 `DATABASE_URL` 时无需迁移，开发服务器会使用内存仓储。

## 6. 停止与重新启动

在运行开发服务器的终端按 `Ctrl+C`，然后重新执行：

```bash
npm run dev
```

修改 `.env.local` 后必须重启服务，新的模型配置才会生效。

## 7. 常见问题

### `MODEL_UNAVAILABLE`

检查 `NEXUS_MODEL_MODE` 不是 `disabled`，并确认 Key、Base URL、Model 三项都已设置。项目不会继承 Codex、ChatGPT 或浏览器登录状态中的模型权限。

### 模型返回 401 或 403

通常是 Key 无效、账户无权访问所选模型，或兼容网关要求不同的凭据。不要把 Key 发到聊天中；在本机更新 `.env.local` 后重启。

### 模型返回 404

检查 Base URL 是否以 API 根路径（通常是 `/v1`）结束，并确认模型名存在。不要在 Base URL 中重复加入 `/chat/completions`。

### 3000 端口已占用

先停止旧的开发服务，再运行 `npm run dev`。如果保留多个实例，应为新实例显式指定不同端口，并同步修改 `PUBLIC_APP_ORIGIN`。

### 数据重启后消失

这是内存仓储的预期行为。需要持久化时配置 PostgreSQL，并按上文执行迁移。

### `npm run typecheck` 报任务交付物 API 模块缺失

当前源码中的测试引用了三个尚未实现的任务交付物 Route；这是已知的业务层开发缺口，不是模型配置或开发服务器启动失败。

## 8. 局域网与生产

- 企业内网试用见 [局域网本地部署](./23-lan-deployment.md)。
- 生产环境见 [生产部署](./11-production-deployment.md) 与 [生产运维](./12-production-operations.md)。
- 生产环境必须关闭演示身份，并使用受管 Secret、真实 IdP、PostgreSQL 和完整 readiness 门禁；不能直接沿用本文的开发配置。
