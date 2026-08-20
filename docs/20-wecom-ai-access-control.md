# 企业微信 AI 权限控制接口

> 本文描述应用配置与权限边界。通过自建应用主动发送消息的正确调用链见 `docs/21-wecom-application-messaging.md`；管理后台不是消息发送通道。

## 目标

让主 Agent 通过受控 Tool Calling 管理企业微信接入，同时保持最小权限、人工确认、租户隔离和密钥隔离。模型永远不接收 `CorpSecret`、应用 Secret、通讯录同步 Secret 或 `access_token`。

## 已实现接口

### Agent Tools

| Tool | 风险 | 渠道 | 所需权限 | 行为 |
|---|---:|---|---|---|
| `wecom.inspect_access_control` | R1 | Web、企业微信 | `wecom_app:read` | 读取连接状态、当前应用配置和权限边界，不产生副作用 |
| `wecom.update_application` | R3 | 仅 Web | `wecom_app:admin` | 修改本应用名称、说明、首页、可信域名、位置上报和进入事件开关；必须人工确认 |

R3 变更会先生成绑定输入摘要、当前身份、工具版本和时效的提案。只有同一用户在有效期内确认同一提案哈希，才会进入持久化 Worker 队列；Worker 执行前再次解析实时权限。

### 管理系统只读 API

```http
GET /api/v1/integrations/wecom/{connectionId}/access-control
```

响应只包含脱敏后的连接状态、应用配置、权限边界和 `traceId`。写操作不提供绕过 Agent 确认机制的直接 HTTP 接口。

## 权限边界

| 能力 | 控制方式 | AI 策略 |
|---|---|---|
| 本应用资料 | 企业微信应用 API | R3，网页管理员确认后执行 |
| 应用可见范围 | 企业微信管理后台 | AI 禁止执行，仅提示系统管理员操作 |
| 可见范围内通讯录读取 | 普通应用 API | 只读 |
| 成员、部门、标签写入 | 独立通讯录同步凭据 | 当前禁用；后续需要独立凭据、审批和更严格审计 |
| 手机号、邮箱、头像等敏感字段 | 成员 OAuth | AI 不能代替成员授权 |
| 本管理系统角色和数据范围 | 系统内部授权策略 | 与企业微信管理员身份分离，AI 禁止直接赋权 |

普通自建应用的 `agent/set_scope` 并不是日常可见范围管理接口，它只用于特定企业注册初始化阶段。`agent/get_permissions` 面向企业授权的代开发或第三方应用，也不能当作普通自建应用的权限查询接口。

## 服务端配置

企业微信应用配置统一写入项目根目录的独立 `.env.wecom.local`，不要与其他 AI 或平台配置混在通用 `.env.local`：

```text
WECOM_AGENT_ID=<应用编号>
WECOM_CORP_ID=<受管配置>
WECOM_APP_SECRET=<受管密钥>
```

`PUBLIC_APP_ORIGIN` 与 `WECOM_ALLOWED_REDIRECT_DOMAINS` 属于管理系统运行配置，仍可留在通用运行环境。真实 Secret 只能由管理员在本机或部署 Secret Broker 中录入，不能写入源码、文档或模型上下文。

生产环境执行写操作前，`connections` 中对应记录必须属于当前租户、provider 为 `wecom` 且状态为 `active`。首页只能使用服务端白名单中的 HTTPS 域名，避免模型把入口改向外部站点。

## 当前外部 Gate

本地接口和安全策略已经实现，但真实企业微信调用仍未验收：

1. 部署域名需要可用 DNS、443、证书和反向代理。
2. 企业微信三项应用配置已由独立配置源识别，但当前调用出口未加入应用的企业可信 IP，真实预检返回 `60020`。
3. 正式 `tenantId`、`connectionId` 与企业微信连接记录尚未激活。
4. 回调 URL、Token、EncodingAESKey 和真实收发消息仍需端到端验证。

在这些条件满足前，只能声明本地工程 Gate 通过，不能声明真实企业微信权限控制已经上线。

## 官方依据

- [获取应用](https://developer.work.weixin.qq.com/document/path/90227)
- [设置应用](https://developer.work.weixin.qq.com/document/path/90228)
- [应用可见范围概念](https://developer.work.weixin.qq.com/document/path/90665)
- [通讯录同步概述](https://developer.work.weixin.qq.com/document/path/90329)
- [通讯录权限体系](https://developer.work.weixin.qq.com/document/path/91143)
- [成员敏感字段限制](https://developer.work.weixin.qq.com/document/path/90196)
- [获取应用权限（代开发/第三方边界）](https://developer.work.weixin.qq.com/document/path/99052)
