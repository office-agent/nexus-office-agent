# 局域网本地部署

## 适用范围

LAN 模式用于企业内网试用、单机服务器和暂不接入 OIDC/企业微信的阶段。它使用显式本地身份，不要求外部 Secret Manager、WAF、OTLP、备份或协作平台验收；不能把这个模式直接暴露到互联网。

## 启动

1. 先在服务器上完成 LLM 的本地环境配置（项目根目录 `.env.local`，密钥不得提交）。
2. 根据服务器局域网地址复制 `.env.lan.example` 的非敏感配置；也可以直接通过命令传入访问源。
3. 构建并启动：

```bash
npm run build
npm run start:lan -- --origin http://192.168.1.20:3117
```

`start:lan` 默认监听 `0.0.0.0:3117`，`--origin` 应替换为服务器稳定的局域网地址。Windows 防火墙只放行企业内网网段，路由器不要做公网端口映射。

## 数据保存

默认 `LAN_STORAGE_MODE=memory`，适合快速试用，但进程重启会清空任务、消息和记忆。正式内网试用建议运行同一台服务器上的 PostgreSQL：

```dotenv
LAN_STORAGE_MODE=postgres
DATABASE_URL=postgres://nexus:<local-password>@127.0.0.1:5432/nexus
```

然后执行 `npm run db:migrate`，再启动 LAN 模式。数据库和密码仍应通过服务器本地受控环境注入。

## 验证

- `/api/v1/health` 返回 200。
- `/api/v1/ready` 在 LAN 模式返回 200，并明确标注本地身份、内存/本地 PostgreSQL 和未接入的外部控制项。
- 浏览器从另一台局域网设备访问 `http://<服务器局域网 IP>:3117/?view=command`。

如果返回 503，优先检查 `lan.identity`、`lan.model`、`lan.storage`；配置了 PostgreSQL 时还要检查迁移和数据库连接。生产模式的 OIDC/PostgreSQL/Secret/WAF/备份门禁仍保持不变。
