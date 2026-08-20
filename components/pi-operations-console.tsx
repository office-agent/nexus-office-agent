"use client";

import { Activity, AlertTriangle, BarChart3, CircleDashed, Clock3, Cpu, Gauge, LockKeyhole, RefreshCw, ServerCog, ShieldCheck, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type ModelRoute = { id: string; routeId: string; version: string; provider: string; model: string; region: string; egress: string; allowedDataClassifications: string[]; status: string; maxInputTokens: number; maxOutputTokens: number; createdAt: string };
type OperationsData = {
  models: ModelRoute[];
  observability: {
    traces: { total: number; succeeded: number; failed: number; blocked: number; unknown: number; averageDurationMs?: number };
    usage: { inputTokens: number; outputTokens: number; costMicros: number; calls: number };
    metrics: Array<{ id: string; traceId: string; name: string; value: number; unit: string; dimensions: Record<string, string>; createdAt: string }>;
    evaluations: Array<{ id: string; suiteId: string; caseId: string; status: string; score: number; threshold: number; correctionRequired: boolean; createdAt: string }>;
    alerts: Array<{ id: string; suiteId: string; metric: string; severity: string; status: string; observed: number; threshold: number; createdAt: string }>;
  };
  recentUsage: Array<{ usageId: string; routeId: string; model: string; dataClassification: string; inputTokens: number; outputTokens: number; latencyMs: number; status: string; costMicros: number; createdAt: string }>;
  quotas: Array<{ policy: { id: string; scope: string; scopeId?: string; version: number; maxConcurrentRuns: number; maxTokens: number; maxCostMicros: number; maxToolCalls: number; status: string }; usage: { concurrentRuns: number; tokens: number; costMicros: number; storageBytes: number; toolCalls: number }; scopeKey: string }>;
  resilience: { killSwitches: Array<{ id: string; scope: string; status: string; reasonCode: string; targetDigest?: string }>; securityEvents: { total: number; highSeverity: number; latestAt?: string }; capacity: Array<{ policy: { id: string; scope: string; version: number; maxConcurrentRuns: number }; active: number }>; faultsEnabled: boolean };
  preproduction: { releases: Array<{ id: string; version: string; imageDigest: string; status: string; createdAt: string; activatedAt?: string; rolledBackAt?: string }>; readiness: Array<{ id: string; releaseId: string; ready: boolean; checks: Array<{ status: string }>; generatedAt: string }>; secretLeases: Array<{ id: string; status: string; expiresAt: string; referenceDigest: string }>; events: Array<{ id: string; kind: string; createdAt: string }>; generatedAt: string };
  pilot: { pilots: Array<{ id: string; name: string; version: string; status: string; startsAt: string; endsAt: string }>; participants: Array<{ id: string; pilotId: string; role: string; status: string }>; journeys: Array<{ id: string; pilotId: string; kind: string; status: string }>; observations: Array<{ id: string; pilotId: string; metric: string; status: string }>; incidents: Array<{ id: string; pilotId: string; severity: string; status: string }>; readiness: Array<{ id: string; pilotId: string; ready: boolean; checks: Array<{ status: string }>; generatedAt: string }>; events: Array<{ id: string; kind: string; createdAt: string }>; generatedAt: string };
  releaseGovernance: { publications: Array<{ id: string; version: string; upstreamVersion: string; status: string; createdAt: string }>; gates: Array<{ id: string; publicationId: string; gateId: string; status: string; validUntil: string }>; risks: Array<{ id: string; publicationId: string; severity: string; status: string }>; approvals: Array<{ id: string; publicationId: string; role: string; decision: string; expiresAt: string }>; rollouts: Array<{ id: string; publicationId: string; stage: string; status: string }>; evaluations: Array<{ id: string; publicationId: string; status: string; score: number; threshold: number }>; gateEvaluations: Array<{ id: string; publicationId: string; ready: boolean; checks: Array<{ status: string }>; generatedAt: string }>; events: Array<{ id: string; kind: string; createdAt: string }>; generatedAt: string };
};

async function readApi<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json() as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "运营数据读取失败");
  if (!payload.data) throw new Error("运营 API 未返回数据");
  return payload.data;
}

function number(value: number) { return value.toLocaleString("zh-CN"); }
function micros(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)} 元` : `${number(value)} μ`; }
function statusLabel(value: string) { return ({ approved: "已批准", pending: "待审核", revoked: "已撤销", rolled_back: "已回退", candidate: "候选", staged: "已暂存", draft: "草稿", rolling_out: "灰度中", completed: "已完成", exited: "已退出", succeeded: "成功", failed: "失败", blocked: "已阻断", unknown: "未知", passed: "通过", pass: "通过", regressed: "回归", open: "待处置", active: "活动", consumed: "已结算", released: "已释放" } as Record<string, string>)[value] ?? value; }
function tone(value: string) { return value === "approved" || value === "succeeded" || value === "passed" || value === "pass" || value === "active" || value === "completed" ? "good" : value === "failed" || value === "blocked" || value === "open" || value === "revoked" || value === "rolled_back" || value === "regressed" || value === "exited" ? "danger" : "wait"; }

export function PiOperationsConsole() {
  const [data, setData] = useState<OperationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setData(await readApi<OperationsData>("/api/v1/pi/admin/operations")); }
    catch (reason) { setData(null); setError(reason instanceof Error ? reason.message : "运营数据读取失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let active = true;
    void readApi<OperationsData>("/api/v1/pi/admin/operations").then((snapshot) => {
      if (!active) return;
      setData(snapshot);
      setError("");
      setLoading(false);
    }).catch((reason) => {
      if (!active) return;
      setData(null);
      setError(reason instanceof Error ? reason.message : "运营数据读取失败");
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  if (loading && !data) return <OperationsState icon={RefreshCw} title="正在读取 Agent 运营快照" detail="只读取租户范围内的 Trace、用量、评测、告警和配额摘要。" spinning />;
  if (!data) return <OperationsState icon={LockKeyhole} title="运营控制面不可用" detail={error || "服务端没有返回运营快照，不填充演示数据。"} tone="danger" action="重新读取" onAction={() => void load()} />;

  const { observability } = data;
  const activeKillSwitches = data.resilience.killSwitches.filter((item) => item.status === "active");
  return <div className="pi-operations-view">
    <header className="pi-operations-head">
      <div><p className="eyebrow">PI OPERATIONS / EVIDENCE CONTROL</p><h1>Agent 运营与质量</h1><p>将模型路由、运行证据、质量回归和预算状态放在同一条可追溯链路上；页面不显示原始提示词、Secret 或供应商凭据。</p></div>
      <button className="pi-ghost-button" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} />刷新快照</button>
    </header>
    <section className={`pi-operations-safety ${activeKillSwitches.length ? "is-alert" : ""}`}><ShieldCheck size={16} /><span><strong>当前边界</strong> 本地控制面已启用；外部模型、OTel、生产限额、真实 Runner 和预生产探针仍未接通时，执行请求继续 fail-closed。</span><span className="pi-operations-digest"><LockKeyhole size={13} />{activeKillSwitches.length ? `${activeKillSwitches.length} 个 Kill Switch 活动` : "Kill Switch 未触发"}</span><span className="pi-operations-digest"><AlertTriangle size={13} />安全事件 {number(data.resilience.securityEvents.total)} · 高危 {number(data.resilience.securityEvents.highSeverity)}</span></section>
    <section className="pi-operations-metrics" aria-label="运营指标概览">
      <Metric icon={Activity} label="Trace" value={observability.traces.total} note={`${observability.traces.failed} 失败 · ${observability.traces.blocked} 阻断`} />
      <Metric icon={Zap} label="模型调用" value={observability.usage.calls} note={`${number(observability.usage.inputTokens + observability.usage.outputTokens)} tokens`} />
      <Metric icon={Gauge} label="成本摘要" value={micros(observability.usage.costMicros)} note={observability.traces.averageDurationMs ? `平均 ${observability.traces.averageDurationMs} ms` : "暂无延迟样本"} text />
      <Metric icon={AlertTriangle} label="质量告警" value={observability.alerts.filter((item) => item.status === "open").length} note={`${observability.evaluations.length} 条评测结果`} />
    </section>
    <div className="pi-operations-grid">
      <section className="pi-operations-panel pi-operations-wide"><PanelHead icon={ServerCog} title="模型路由与数据边界" meta={`${data.models.length} 个服务端路由`} />{data.models.length === 0 ? <EmptyOperations title="没有批准模型路由" detail="模型路由需先由服务端发布、审核和配置 Provider；不会回退到未批准模型。" /> : <div className="pi-model-list">{data.models.map((model) => <article key={`${model.routeId}:${model.version}`}><div><span className="pi-kicker">{model.routeId} · v{model.version}</span><strong>{model.provider} / {model.model}</strong><small>{model.region} · {model.egress} egress · {model.allowedDataClassifications.join(" / ")}</small></div><div className="pi-operations-side"><StatusBadge value={statusLabel(model.status)} tone={tone(model.status)} /><small>{number(model.maxInputTokens)} in · {number(model.maxOutputTokens)} out</small></div></article>)}</div>}</section>
      <section className="pi-operations-panel"><PanelHead icon={Cpu} title="评测与回归" meta={`${observability.evaluations.length} 个结果`} />{observability.evaluations.length === 0 ? <EmptyOperations title="没有评测结果" detail="评测结果由受控评测接口写入；页面不以空状态推断质量通过。" /> : <div className="pi-evaluation-list">{observability.evaluations.slice(0, 8).map((item) => <article key={item.id}><div><span className="pi-kicker">{item.suiteId} / {item.caseId}</span><strong>{Math.round(item.score * 100)}% <small>阈值 {Math.round(item.threshold * 100)}%</small></strong></div><StatusBadge value={statusLabel(item.status)} tone={tone(item.status)} /></article>)}</div>}</section>
      <section className="pi-operations-panel"><PanelHead icon={BarChart3} title="硬预算与预留" meta={`${data.quotas.length} 条策略`} />{data.quotas.length === 0 ? <EmptyOperations title="没有配额策略" detail="没有服务端策略时不会暗中放宽预算；真实执行仍保持关闭。" /> : <div className="pi-quota-list">{data.quotas.map((item) => <article key={item.policy.id}><div><span className="pi-kicker">{item.scopeKey} · v{item.policy.version}</span><strong>{number(item.usage.tokens)} / {number(item.policy.maxTokens)} tokens</strong><small>成本 {micros(item.usage.costMicros)} · Tool {number(item.usage.toolCalls)} / {number(item.policy.maxToolCalls)}</small></div><span className="pi-quota-bar"><i style={{ width: `${Math.min(100, item.policy.maxTokens ? item.usage.tokens / item.policy.maxTokens * 100 : 0)}%` }} /></span></article>)}</div>}</section>
      <section className="pi-operations-panel pi-operations-wide"><PanelHead icon={Clock3} title="最近模型用量" meta={`${data.recentUsage.length} 条脱敏记录`} />{data.recentUsage.length === 0 ? <EmptyOperations title="暂无用量记录" detail="没有调用记录时不创建虚构成本；模型 Provider 未配置时请求会返回安全拒绝。" /> : <div className="pi-usage-table"><div className="pi-usage-row pi-usage-head-row"><span>路由</span><span>数据级别</span><span>Tokens</span><span>延迟</span><span>结果 / 成本</span></div>{data.recentUsage.slice(0, 10).map((item) => <div className="pi-usage-row" key={item.usageId}><span><b>{item.routeId}</b><small>{item.model}</small></span><span>{item.dataClassification}</span><span>{number(item.inputTokens + item.outputTokens)}</span><span>{number(item.latencyMs)} ms</span><span><StatusBadge value={statusLabel(item.status)} tone={tone(item.status)} /><small>{micros(item.costMicros)}</small></span></div>)}</div>}</section>
      <section className="pi-operations-panel"><PanelHead icon={AlertTriangle} title="回归告警" meta={`${observability.alerts.length} 条历史告警`} />{observability.alerts.length === 0 ? <EmptyOperations title="暂无回归告警" detail="告警列表来自评测写入；空状态不等于通过 Gate。" /> : <div className="pi-alert-list">{observability.alerts.slice(0, 8).map((item) => <article key={item.id}><div><span className="pi-kicker">{item.severity} · {item.suiteId}</span><strong>{item.metric}</strong><small>{item.observed} / 阈值 {item.threshold}</small></div><StatusBadge value={statusLabel(item.status)} tone={tone(item.status)} /></article>)}</div>}</section>
      <section className="pi-operations-panel"><PanelHead icon={LockKeyhole} title="安全与背压" meta={`${data.resilience.capacity.length} 条容量策略`} />{activeKillSwitches.length ? <div className="pi-alert-list">{activeKillSwitches.map((item) => <article key={item.id}><div><span className="pi-kicker">{item.scope}</span><strong>{item.reasonCode}</strong><small>{item.targetDigest ? `资源 ${item.targetDigest}` : "新执行已阻断"}</small></div><StatusBadge value="活动" tone="danger" /></article>)}</div> : <EmptyOperations title="没有活动 Kill Switch" detail={data.resilience.capacity.length ? `容量策略已加载，${data.resilience.capacity.reduce((sum, item) => sum + item.active, 0)} 个运行预留处于活动状态。` : "安全门禁为空不等于生产通过；外部故障和隔离攻击仍待 G-035。"} />}</section>
      <section className="pi-operations-panel pi-operations-wide"><PanelHead icon={ShieldCheck} title="预生产门禁" meta={`${data.preproduction.releases.length} 个发布候选 · ${data.preproduction.secretLeases.length} 个 Secret Lease`} />{data.preproduction.releases.length === 0 ? <EmptyOperations title="没有发布候选" detail="发布版本必须先通过真实预生产探针、灾备恢复和安全扫描，默认探针未接通时保持 fail-closed。" /> : <div className="pi-alert-list">{data.preproduction.releases.slice(0, 8).map((release) => { const readiness = data.preproduction.readiness.find((item) => item.releaseId === release.id); return <article key={release.id}><div><span className="pi-kicker">v{release.version} · {release.id.slice(0, 8)}</span><strong>{readiness?.ready ? "就绪证据已通过" : "未形成可发布证据"}</strong><small>{readiness ? `${readiness.checks.length} 项检查 · ${new Date(readiness.generatedAt).toLocaleString("zh-CN")}` : "尚未执行就绪评估"}</small></div><StatusBadge value={statusLabel(release.status)} tone={tone(release.status)} /></article>; })}</div>}<p className="pi-operations-note">当前只保留 release/image/manifest 的摘要和状态；Secret Lease 仅展示摘要 digest 与生命周期，不展示 Secret 引用。G-036 仍需真实预生产与灾备环境验收。</p></section>
      <section className="pi-operations-panel pi-operations-wide"><PanelHead icon={ShieldCheck} title="企业试点门禁" meta={`${data.pilot.pilots.length} 个 Pilot · ${data.pilot.journeys.length} 条旅程`} />{data.pilot.pilots.length === 0 ? <EmptyOperations title="没有试点项目" detail="真实试点必须先完成 G-036、项目授权和退出方案；空状态不代表试点通过。" /> : <div className="pi-alert-list">{data.pilot.pilots.slice(0, 8).map((pilot) => { const readiness = data.pilot.readiness.find((item) => item.pilotId === pilot.id); const journeys = data.pilot.journeys.filter((item) => item.pilotId === pilot.id); return <article key={pilot.id}><div><span className="pi-kicker">{pilot.name} · v{pilot.version}</span><strong>{readiness?.ready ? "试点证据已通过" : "尚未形成试点 Gate 证据"}</strong><small>{journeys.length} 条旅程 · {readiness ? `${readiness.checks.length} 项检查` : "尚未执行 readiness"}</small></div><StatusBadge value={statusLabel(pilot.status)} tone={tone(pilot.status)} /></article>; })}</div>}<p className="pi-operations-note">Pilot 只展示成员/旅程/观察/事故的计数和状态，不展示主体原文、代码、PR、模型输出或隐私数据。G-037 仍需真实团队四周六类旅程和退出演练。</p></section>
      <section className="pi-operations-panel pi-operations-wide"><PanelHead icon={ServerCog} title="1.0 发布治理" meta={`${data.releaseGovernance.publications.length} 个候选 · ${data.releaseGovernance.risks.length} 个风险`} />{data.releaseGovernance.publications.length === 0 ? <EmptyOperations title="没有 1.0 发布候选" detail="发布候选必须绑定全部 Gate、风险、双人签字、签名制品、SBOM 和回退点；默认发布探针保持 no-go。" /> : <div className="pi-alert-list">{data.releaseGovernance.publications.slice(0, 8).map((publication) => { const evaluation = data.releaseGovernance.gateEvaluations.find((item) => item.publicationId === publication.id); const risks = data.releaseGovernance.risks.filter((item) => item.publicationId === publication.id && item.status === "open"); return <article key={publication.id}><div><span className="pi-kicker">v{publication.version} · Pi {publication.upstreamVersion}</span><strong>{evaluation?.ready ? "发布 Gate 已通过" : "未形成可发布 Gate 证据"}</strong><small>{risks.length} 个未关闭风险 · {evaluation ? `${evaluation.checks.length} 项检查` : "尚未评估"}</small></div><StatusBadge value={statusLabel(publication.status)} tone={tone(publication.status)} /></article>; })}</div>}<p className="pi-operations-note">灰度/回退仅记录受审计动作摘要，不直接切换生产流量；签名制品、发布委员会、真实 Deployment/Runner、持续评测和 G-038 仍未通过。</p></section>
    </div>
    <footer className="pi-operations-footer"><CircleDashed size={14} /><span>运营视图只显示摘要、计数、摘要 digest 和策略状态；原始内容、Secret、endpoint 和跨租户用量不进入页面。</span><span><Clock3 size={13} />M30/M31/M32/M33/M34 本地控制面，G-034～G-038 尚未通过</span></footer>
  </div>;
}

function Metric({ icon: Icon, label, value, note, text = false }: { icon: typeof Activity; label: string; value: number | string; note: string; text?: boolean }) { return <div className="pi-operations-metric"><Icon size={16} /><span>{label}</span><strong className={text ? "is-text" : ""}>{value}</strong><small>{note}</small></div>; }
function PanelHead({ icon: Icon, title, meta }: { icon: typeof Activity; title: string; meta: string }) { return <header className="pi-operations-panel-head"><div><span><Icon size={15} />{title}</span><small>{meta}</small></div><Activity size={13} /></header>; }
function StatusBadge({ value, tone: badgeTone }: { value: string; tone: string }) { return <span className={`pi-status-badge is-${badgeTone}`}><i />{value}</span>; }
function EmptyOperations({ title, detail }: { title: string; detail: string }) { return <div className="pi-operations-empty"><CircleDashed size={22} /><strong>{title}</strong><span>{detail}</span></div>; }
function OperationsState({ icon: Icon, title, detail, action, onAction, spinning = false, tone = "neutral" }: { icon: typeof LockKeyhole; title: string; detail: string; action?: string; onAction?: () => void; spinning?: boolean; tone?: "neutral" | "danger" }) { return <div className={`pi-operations-state is-${tone}`}><Icon className={spinning ? "spin" : ""} size={25} /><strong>{title}</strong><p>{detail}</p>{action && onAction ? <button onClick={onAction}>{action}<Activity size={14} /></button> : null}</div>; }
