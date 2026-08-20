"use client";

import { Activity, ArrowRight, CheckCircle2, KeyRound, Link2, RefreshCw, Send, ShieldCheck, TriangleAlert, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

type ProviderId = "feishu" | "dingtalk" | "wecom";
type RuntimeStatus = {
  identity?: { mode: "demo" | "oidc" | "verified-provider-required" };
  secretManagement?: { configured: boolean };
  observability?: { configured: boolean };
  backup?: { configured: boolean };
  connectors?: Record<ProviderId, { configured: boolean }>;
};
type ReadinessCheck = { id: string; category: string; status: "pass" | "fail" | "warning"; message: string };
type AcceptanceStep = { id: string; status: "passed" | "failed" | "blocked"; summary: string; code?: string; checkedAt: string };
type AcceptanceRun = { id: string; status: "passed" | "failed" | "blocked"; steps: AcceptanceStep[]; completedAt: string };
type AcceptanceConnection = { id: string; provider: ProviderId; name: string; status: string; transportMode?: string; latestRun?: AcceptanceRun };
type AcceptanceOverview = { identity?: AcceptanceRun; connections: AcceptanceConnection[]; generatedAt?: string };
type TestNotificationProposal = { id: string; provider: ProviderId; connectionId: string; recipientType: "user" | "chat"; proposalHash: string; expiresAt: string; preview: string; messageVersion: number };
type TestNotificationResult = { status: "delivered" | "failed" | "unknown"; receiptDigest?: string; errorCategory?: string; executedAt?: string; replayed?: boolean };

const providers: Array<{ id: ProviderId; name: string; mark: string; transport: string; verification: string; capabilities: string[] }> = [
  { id: "feishu", name: "飞书", mark: "飞", transport: "长连接优先 · HTTP 兼容", verification: "SHA-256 签名、Token、时间窗、防重放", capabilities: ["机器人消息", "互动卡片", "组织通讯录", "日历/审批"] },
  { id: "dingtalk", name: "钉钉", mark: "钉", transport: "Stream 优先 · 加密 HTTP 兼容", verification: "SHA-1 签名、AES、ReceiveId、防重放", capabilities: ["机器人消息", "互动卡片", "组织通讯录", "日历/审批"] },
  { id: "wecom", name: "企业微信", mark: "企", transport: "HTTPS 回调", verification: "URL 校验、SHA-1、AES-XML、CorpId", capabilities: ["应用消息", "模板卡片", "组织通讯录", "网页授权"] },
];

export function IntegrationCenterView({ onNotice }: { onNotice: (message: string) => void }) {
  const [runtime, setRuntime] = useState<RuntimeStatus>({});
  const [readiness, setReadiness] = useState<{ status: string; mode: string; checks: ReadinessCheck[] }>({ status: "not_ready", mode: "development", checks: [] });
  const [acceptance, setAcceptance] = useState<AcceptanceOverview>({ connections: [] });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState("");
  const [testProvider, setTestProvider] = useState<ProviderId>("feishu");
  const [recipientType, setRecipientType] = useState<"user" | "chat">("user");
  const [externalRecipientId, setExternalRecipientId] = useState("");
  const [testProposal, setTestProposal] = useState<TestNotificationProposal | null>(null);
  const [testResult, setTestResult] = useState<TestNotificationResult | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [healthResponse, readinessResponse, acceptanceResponse] = await Promise.all([fetch("/api/v1/health", { cache: "no-store" }), fetch("/api/v1/ready", { cache: "no-store" }), fetch("/api/v1/integrations/acceptance", { cache: "no-store" })]);
      const [healthPayload, readinessPayload, acceptancePayload] = await Promise.all([healthResponse.json(), readinessResponse.json(), acceptanceResponse.json()]);
      setRuntime(healthPayload.runtime ?? {});
      setReadiness(readinessPayload);
      if (acceptanceResponse.ok) setAcceptance(acceptancePayload.data ?? { connections: [] });
    } finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    void Promise.all([fetch("/api/v1/health", { cache: "no-store" }).then((response) => response.json()), fetch("/api/v1/ready", { cache: "no-store" }).then((response) => response.json()), fetch("/api/v1/integrations/acceptance", { cache: "no-store" }).then((response) => response.json())])
      .then(([healthPayload, readinessPayload, acceptancePayload]) => { if (active) { setRuntime(healthPayload.runtime ?? {}); setReadiness(readinessPayload); setAcceptance(acceptancePayload.data ?? { connections: [] }); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function runAcceptance(key: string, path: string) {
    setRunning(key);
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "接入预检执行失败");
      await load();
      onNotice(payload.data.status === "passed" ? "企业接入预检通过，安全证据已追加保存" : payload.data.status === "blocked" ? "预检已完成：仍有外部配置前置条件" : "预检发现真实连接故障，请按步骤代码处理");
    } catch (error) { onNotice(error instanceof Error ? error.message : "接入预检执行失败"); }
    finally { setRunning(""); }
  }

  async function prepareTestNotification(connection: AcceptanceConnection) {
    setRunning("test-notification-prepare");
    setTestResult(null);
    try {
      const response = await fetch("/api/v1/integrations/test-notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: connection.provider, connectionId: connection.id, recipientType, externalRecipientId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "无法生成测试通知确认方案");
      setTestProposal(payload.data);
      onNotice("已生成绑定收件人摘要的待确认方案，尚未发送");
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法生成测试通知确认方案"); }
    finally { setRunning(""); }
  }

  async function confirmTestNotification() {
    if (!testProposal) return;
    setRunning("test-notification-confirm");
    try {
      const response = await fetch(`/api/v1/integrations/test-notifications/${testProposal.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalHash: testProposal.proposalHash, externalRecipientId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "测试通知确认失败");
      setTestResult(payload.data);
      setTestProposal(null);
      onNotice(payload.data.status === "delivered" ? "平台已接受测试通知，回执摘要已留存" : payload.data.status === "unknown" ? "发送结果无法确认，已停止重试并要求人工核对" : "平台明确拒绝了测试通知");
    } catch (error) { onNotice(error instanceof Error ? error.message : "测试通知确认失败"); }
    finally { setRunning(""); }
  }

  const statusLabel = (status?: AcceptanceRun["status"]) => status === "passed" ? "已验证" : status === "failed" ? "连接失败" : status === "blocked" ? "等待配置" : "未验证";
  const eligibleConnections = acceptance.connections.filter((item) => item.status === "active" && item.latestRun?.status === "passed");
  const selectedTestConnection = eligibleConnections.find((item) => item.provider === testProvider) ?? eligibleConnections[0];

  return (
    <div className="integration-view">
      <header className="integration-hero">
        <div>
          <p className="eyebrow">CHANNEL CONTROL PLANE</p>
          <h1>系统与集成</h1>
          <p>所有渠道共享同一业务事实、权限、Agent 确认和审计链路；外部平台不保存内部管理状态。</p>
        </div>
        <button onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />重新探测</button>
      </header>

      <section className="integration-summary">
        <div><Link2 size={18} /><span><strong>3</strong><small>统一协议适配</small></span></div>
        <div><ShieldCheck size={18} /><span><strong>R3</strong><small>渠道确认重新鉴权</small></span></div>
        <div><Activity size={18} /><span><strong>幂等</strong><small>事件与通知全局去重</small></span></div>
        <div><KeyRound size={18} /><span><strong>{runtime.secretManagement?.configured ? "托管" : "隔离"}</strong><small>密钥只按引用解析</small></span></div>
      </section>

      <section className="production-readiness">
        <header>
          <div><p className="eyebrow">PRODUCTION CONTROL GATE</p><h2>企业上线就绪门禁</h2><p>进程存活不等于可上线。身份、数据、AI、密钥、运维和渠道控制必须同时通过。</p></div>
          <div className="readiness-actions"><span className={readiness.status === "ready" ? "readiness-badge ready" : "readiness-badge blocked"}>{readiness.status === "ready" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{readiness.status === "ready" ? "允许承载生产流量" : "暂不允许生产流量"}</span><button disabled={Boolean(running)} onClick={() => void runAcceptance("identity", "/api/v1/integrations/acceptance/identity")}>{running === "identity" ? <RefreshCw size={13} className="spin"/> : <ShieldCheck size={13}/>}验证身份源</button></div>
        </header>
        <div className="readiness-grid">
          {readiness.checks.map((item) => (
            <div key={item.id} className={`readiness-item ${item.status}`}>
              {item.status === "pass" ? <CheckCircle2 size={14} /> : item.status === "warning" ? <TriangleAlert size={14} /> : <XCircle size={14} />}
              <span><strong>{item.id}</strong><small>{item.message}</small></span>
            </div>
          ))}
        </div>
        {acceptance.identity ? <div className="identity-acceptance"><div><strong>OIDC 真实预检</strong><small>{statusLabel(acceptance.identity.status)} · {new Date(acceptance.identity.completedAt).toLocaleString("zh-CN")}</small></div><div className="acceptance-steps">{acceptance.identity.steps.map((item) => <span key={item.id} className={item.status}><i />{item.id}<b>{item.code ?? item.status}</b></span>)}</div></div> : null}
        <footer><span>身份模式：{runtime.identity?.mode ?? "探测中"}</span><span>遥测：{runtime.observability?.configured ? "已连接" : "待配置"}</span><span>备份：{runtime.backup?.configured ? "已配置" : "待演练"}</span><span>环境：{readiness.mode}</span></footer>
      </section>

      <section className="provider-grid">
        {providers.map((provider) => {
          const configured = Boolean(runtime.connectors?.[provider.id]?.configured);
          const connection = acceptance.connections.find((item) => item.provider === provider.id);
          const latest = connection?.latestRun;
          return (
            <article className="provider-card" key={provider.id}>
              <div className="provider-card-head">
                <span className={`provider-mark provider-${provider.id}`}>{provider.mark}</span>
                <div><h2>{provider.name}</h2><p>{provider.transport}</p></div>
                <span className={latest?.status === "passed" ? "connection-state ready" : "connection-state pending"}>{latest?.status === "passed" ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />}{statusLabel(latest?.status)}</span>
              </div>
              <div className="provider-security"><ShieldCheck size={14} /><span>{provider.verification}</span></div>
              <div className="capability-list">{provider.capabilities.map((item) => <span key={item}>{item}</span>)}</div>
              {latest ? <div className="acceptance-steps provider-acceptance">{latest.steps.map((item) => <span key={item.id} className={item.status}><i />{item.id}<b>{item.code ?? item.status}</b></span>)}</div> : null}
              <div className="provider-foot">
                <small>{latest ? `${latest.steps.filter((item) => item.status === "passed").length}/${latest.steps.length} 步通过；报告只保存安全摘要。` : configured ? "运行凭据已提供；尚未形成真实平台证据。" : "协议与 Fixture 已就绪；运行预检可生成缺口清单。"}</small>
                <button disabled={Boolean(running) || !connection} onClick={() => connection && void runAcceptance(provider.id, `/api/v1/integrations/acceptance/connectors/${provider.id}/${connection.id}`)}>{running === provider.id ? "探测中…" : "运行预检"}<ArrowRight size={13} /></button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="delivery-governance">
        <div className="governance-copy"><p className="eyebrow">DELIVERY GOVERNANCE</p><h2>一条通知，只产生一次可控副作用</h2><p>路由先读取用户渠道偏好，再原子领取全局通知 ID。遇到限流按平台指示安排重试；渠道故障不影响网页业务事实。</p></div>
        <div className="governance-flow">
          <div><span>01</span><strong>选择渠道</strong><small>偏好、静默时段、能力</small></div>
          <i />
          <div><span>02</span><strong>原子去重</strong><small>通知 ID + 幂等键</small></div>
          <i />
          <div><span>03</span><strong>发送与回执</strong><small>限流、退避、审计</small></div>
        </div>
        <div className="delivery-test-control">
          <div className="delivery-test-fields">
            <label><span>验收渠道</span><select value={selectedTestConnection?.provider ?? testProvider} disabled={!eligibleConnections.length || Boolean(testProposal)} onChange={(event) => setTestProvider(event.target.value as ProviderId)}>{eligibleConnections.length ? eligibleConnections.map((item) => <option key={item.id} value={item.provider}>{providers.find((provider) => provider.id === item.provider)?.name ?? item.provider}</option>) : <option value="feishu">暂无已通过连接</option>}</select></label>
            <label><span>收件类型</span><select value={recipientType} disabled={!eligibleConnections.length || Boolean(testProposal)} onChange={(event) => setRecipientType(event.target.value as "user" | "chat")}><option value="user">测试用户</option><option value="chat">测试会话</option></select></label>
            <label className="delivery-recipient"><span>外部收件人 ID</span><input value={externalRecipientId} disabled={!eligibleConnections.length || Boolean(testProposal)} maxLength={160} autoComplete="off" spellCheck={false} placeholder={recipientType === "user" ? "open_id / userId" : "chat_id / conversationId"} onChange={(event) => setExternalRecipientId(event.target.value)} /></label>
          </div>
          <p className="delivery-safety-note"><ShieldCheck size={13} />收件人原文不写入确认方案；方案只保存 SHA-256 摘要，5 分钟后失效。</p>
          {!eligibleConnections.length ? <div className="delivery-blocked"><TriangleAlert size={14} /><span>至少需要一个处于“激活”状态且真实预检通过的企业连接。</span></div> : null}
          {testProposal ? <div className="delivery-confirmation"><div><strong>待管理员确认</strong><p>{testProposal.preview}</p><small>到期：{new Date(testProposal.expiresAt).toLocaleTimeString("zh-CN")}，方案版本 v{testProposal.messageVersion}</small></div><div><button className="secondary" onClick={() => setTestProposal(null)} disabled={Boolean(running)}>取消</button><button className="delivery-test" onClick={() => void confirmTestNotification()} disabled={Boolean(running)}>{running === "test-notification-confirm" ? <RefreshCw size={14} className="spin" /> : <ShieldCheck size={14} />}确认并发送</button></div></div> : <button className="delivery-test" disabled={!selectedTestConnection || !externalRecipientId.trim() || Boolean(running)} onClick={() => selectedTestConnection && void prepareTestNotification(selectedTestConnection)}>{running === "test-notification-prepare" ? <RefreshCw size={14} className="spin" /> : <Send size={14} />}生成待确认方案</button>}
          {testResult ? <div className={`delivery-result ${testResult.status}`}>{testResult.status === "delivered" ? <CheckCircle2 size={15} /> : testResult.status === "failed" ? <XCircle size={15} /> : <TriangleAlert size={15} />}<span><strong>{testResult.status === "delivered" ? "平台已接受" : testResult.status === "failed" ? "发送失败" : "结果未知，已停止重试"}</strong><small>{testResult.receiptDigest ? `回执摘要 ${testResult.receiptDigest.slice(0, 12)}…` : testResult.errorCategory ?? "请人工在平台侧核对"}</small></span></div> : null}
        </div>
      </section>
    </div>
  );
}
