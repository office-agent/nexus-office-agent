# 贡献指南

感谢参与 Nexus Office Agent。这个项目涉及多租户、Agent Tool、代码执行和企业数据，贡献必须同时满足功能、权限、审计和回退要求。

## 开发流程

1. 从 `main` 创建分支，说明改动范围和风险。
2. 先阅读相关设计文档、公开功能清单和安全边界。
3. 保持 Web/API、Agent Controller、Pi Runner、Sandbox 和 Tool Gateway 的职责边界。
4. 为新行为补充测试；测试标题或文件头应注明对应需求/安全约束。
5. 本地执行：

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```

6. 更新受影响的 API、功能清单、交接材料和回退说明。
7. Pull Request 中区分“本地已验证”“依赖外部环境”“尚未验证”，不要把模拟结果写成生产证据。

## 不接受的改动

- 在浏览器或 Next.js Web 进程内直接运行 Pi、Shell、Git、MCP 或部署命令；
- 通过客户端字段决定 tenant、actor、权限、模型 Key、MCP Token 或执行凭据；
- 未经策略和人工确认执行高风险 Tool、合并、发布、财务、人事或权限变更；
- 加载未批准的 Skill、Extension、Package 或从公网运行时安装依赖；
- 提交 Secret、真实企业数据、内部地址、生产日志或未脱敏截图。

## 变更说明

涉及数据库、公共 API、Tool Schema、MCP、审批、Runner 协议、Sandbox 或安全策略的改动，必须在 PR 中写清楚兼容性、迁移、验收和回退路径。

安全漏洞请不要公开创建 Issue，按 [安全策略](./SECURITY.md) 报告。
