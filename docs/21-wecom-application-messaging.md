# 企业微信自建应用消息接口

## 正确调用链

管理后台只用于创建自建应用、设置可见范围和初始化凭据，不参与日常消息发送。AI 的运行链路为：

1. 网页端 AI 选择 `wecom.send_application_message`。
2. 系统展示接收人完整姓名和消息正文，等待人工确认。
3. 服务端使用当前租户连接对应的 `CorpID + 应用 Secret` 换取 `access_token`。
4. 服务端调用 `/cgi-bin/user/simplelist?department_id=1&fetch_child=1`，只在应用可见范围内按完整姓名精确匹配成员。
5. 仅当姓名唯一匹配时，服务端将成员 UserID 和服务端配置的 AgentId 传给 `/cgi-bin/message/send`。
6. 系统只向 AI 返回成员姓名、发送状态、时间和消息回执摘要，不返回 UserID、Secret、token 或平台原始回执。

出站消息不依赖回调域名和 HTTPS 回调配置；入站消息、OAuth 和事件回调仍需要可访问的 HTTPS 域名。

## AI 接口

工具：`wecom.send_application_message`

```json
{
  "connectionId": "21000000-0000-4000-8000-000000000003",
  "recipientName": "王渊芃",
  "text": "VastMind AI 企业微信应用接口已连通（测试消息）。"
}
```

安全策略：

- 风险等级 R3，始终人工确认；
- 仅网页端可发起，企业微信聊天不能反向命令应用给其他人发消息；
- 需要 `wecom_message:send` 权限；
- 连接必须属于当前租户且状态为 `active`；
- 重名、查无此人、失效 UserID、平台错误或缺少回执一律失败关闭；
- 外发幂等键由 Agent 执行上下文生成，单次执行不自动扩大收件范围。

## 服务端配置

本地开发使用项目根目录下独立的 `.env.wecom.local`，不要把企业微信应用凭据写进通用 `.env.local`。该文件存在时是企业微信三项配置的唯一来源，不会回退读取通用环境中的同名字段：

```dotenv
WECOM_CORP_ID=<企业ID>
WECOM_APP_SECRET=<受管应用Secret>
WECOM_AGENT_ID=<应用编号>
```

仓库只提交无敏感值的 `.env.wecom.example`；`.env.wecom.local` 已被忽略。部署环境未挂载该专用文件时，仍可由部署平台或 Secret Manager 注入同名环境变量。

生产环境还需要在租户的 `connections` 记录中登记并激活企业微信连接，并向指定管理角色授予 `wecom_message:send`。权限目录由 `0021_wecom_application_message_permission.sql` 创建。

## 当前真实测试状态

截至 2026-08-17，独立 `.env.wecom.local` 的三项配置均已被服务端识别，健康接口显示企业微信连接器来自 `dedicated-environment`。真实只读 `agent/get` 预检被企业微信以 `60020`（不安全的访问 IP）拒绝，因此系统没有继续解析成员或调用 `message/send`，也没有向“王渊芃”发送消息。下一步必须从已加入企业可信 IP 的自有服务器稳定出口执行；出站消息本身仍不依赖 DNS 或回调配置。
