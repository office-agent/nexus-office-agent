# 11 生产部署与企业接入

## 1. 上线原则

生产发布必须同时满足三层条件：镜像可启动、`/api/v1/health` 存活、`/api/v1/ready` 返回 200。后两者不可互相替代。演示身份、内存仓储、环境内联回调密钥或未声明的边缘防护都会让就绪门禁失败。

部署拓扑为无状态 Web/API 多副本 + Inbox/Agent/Outbox Worker + PostgreSQL 主备 + 受管入口网关/WAF/分布式限流 + OTLP 遥测后端 + 受管密钥代理 + 版本化不可变备份存储。连接器长连接 Worker 和知识索引 Worker 在容量或隔离需求出现时从同一领域内核拆出；持久化执行 Worker 从 `0.12.0-durable-runtime` 起属于必需运行面，不能只部署 Web。

## 2. 身份提供方接入

1. 在企业 IdP 注册机密 OIDC 客户端，回调固定为 `/api/v1/auth/callback`，只允许 Authorization Code Flow。
2. 提供 discovery issuer、client ID、client secret 和 HTTPS redirect URI；生产保持 `NEXUS_ALLOW_DEMO_IDENTITY=false`。
3. 管理员从 IdP 获取稳定且不可复用的 `sub`，以 `规范化 issuer::sub` 为键配置 `OIDC_SUBJECT_MAP_JSON`。映射值必须明确给出 `tenantId`、`actorId`、`roles`、`permissions` 和 `dataScopes`。
4. 禁止按邮箱、手机或姓名自动匹配。入转调离由 IdP 与平台账号管理流程更新显式映射；离职先撤映射与会话，再停 IdP 账号。
5. 登录实现校验 state、nonce、PKCE、RS256/JWKS、issuer、audience、azp 与时间声明；状态和会话 Cookie 均为 HttpOnly、SameSite=Lax，生产增加 Secure。

会话轮换采用“新主密钥 + 单个旧密钥宽限”：先把旧值放入 `SESSION_SECRET_PREVIOUS`，再替换 `SESSION_SECRET`；等待最长会话周期后清除旧值。两个值都只能由部署 Secret 注入。

## 3. 镜像与 Kubernetes

仓库提供 Web/API `runner`、Worker `worker` 和运维 `operations` Docker target。Worker target 运行 Inbox、Agent、Outbox 角色，可按环境变量拆分部署；运维 target 运行迁移、备份和恢复工具。所有 target 来自同一提交和版本，运行镜像只携带生产依赖，不包含测试工具链。

```bash
docker build --target runner -t registry.example.com/nexus-office:0.14.0 .
docker build --target worker -t registry.example.com/nexus-office-worker:0.14.0 .
docker build --target operations -t registry.example.com/nexus-office-operations:0.14.0 .
```

`deploy/kubernetes/` 包含 Web 三副本、三类 Worker、探针、HPA、PDB、默认入口隔离、前向迁移 Job 和每 15 分钟备份 CronJob 示例。Web Readiness 要求所需 Worker 存在同版本新鲜心跳。示例域名、镜像地址、PVC 与 Secret 名必须由平台团队替换。`nexus-office-runtime` 至少包含数据库、OIDC client secret/主体映射、模型凭据、Secret broker bootstrap token 和启用连接器凭据；不得把 Secret 值写入 ConfigMap。

发布顺序：构建并扫描镜像 → 备份 → 执行迁移 Job → 部署一个 canary → `ready`/核心旅程验证 → 滚动扩容 → 观察一个错误预算窗口。数据库只做前向迁移；字段删除、重命名和收紧约束采用 expand/migrate/contract，多版本兼容后再清理。

## 4. 平台应用安装

每个环境使用独立应用和独立回调密钥。连接表只保存 `secret://租户/平台/安装/current` 形式的引用。

- 飞书：优先长连接，HTTP 兼容模式启用 Encrypt Key 与 Verification Token；授权机器人消息、互动卡片、通讯录、日历/审批所需最小 scopes。
- 钉钉：优先 Stream，HTTP 模式配置 Token、EncodingAESKey、ReceiveId；生产与测试 Stream 客户端不得消费同一事件源。
- 企业微信：使用 HTTPS 回调，配置 Token、EncodingAESKey、CorpId/AgentId；入口只经 WAF/API Gateway 暴露。

安装验收依次执行 URL/连接鉴权、组织小样本同步、入站事件、重复事件、卡片确认、发送回执、限流/超时和撤权。真实企业结果记录到 A-005；fixture 通过不能替代真实授权。

上线前在“系统与集成”页依次执行 `POST /api/v1/integrations/acceptance/identity`、三个连接器预检与 `GET /api/v1/integrations/acceptance`证据复核。只有状态为 `active`、最新预检全通过且已绑定明确外部企业 ID 的连接，才会开放测试通知确认区。管理员先调用 `POST /api/v1/integrations/test-notifications` 生成方案，再使用 `POST /api/v1/integrations/test-notifications/{id}/confirm` 确认；绝不跳过第一阶段，也不在未知结果后再次点击。

## 5. 生产 Secret 代理契约

应用以固定 HTTPS POST 调用 `SECRET_MANAGER_URL`，使用 bootstrap token 鉴权，请求仅包含不透明 `ref` 和最小化 `purpose`。响应为 `{ "value": ... }`；状态接口、错误和日志均不返回值。连接器解析缓存最长 60 秒，轮换通过移动 `current` 引用完成。

生产只接受 `SECRET_PROVIDER=managed-http`。Secret broker 应实现工作负载身份、调用方/用途授权、审计、版本和轮换；bootstrap token 由平台 Secret 注入并定期轮换。

## 6. 发布检查

- `npm run typecheck && npm run lint && npm test && npm run build` 全绿，高危生产依赖为 0。
- Secret/PII 扫描无命中，镜像以非 root、只读根文件系统运行。
- `ready` 所有项目通过，数据库依赖探测成功，OIDC 真实登录/登出/撤权通过。
- 至少一个测试企业连接器真实 E2E 通过；要宣称全渠道完成则三平台均须通过。
- 备份恢复、迁移补偿、会话/连接器密钥轮换和告警路由演练有当日证据。
