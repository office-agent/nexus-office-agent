"use client";

import {
  Activity,
  ArrowRight,
  Bot,
  CalendarClock,
  Check,
  CircleAlert,
  ClipboardCheck,
  Database,
  FileWarning,
  LoaderCircle,
  MessageSquareText,
  Plus,
  RefreshCw,
  Scale,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Quality = { id: string; status: "missing" | "stale" | "unverified" | "healthy"; checkedAt: string; observedAt?: string; completenessPercent: number; evidenceRefs: string[] };
type Occurrence = { id: string; cadenceId: string; scheduledStartAt: string; scheduledEndAt: string; status: string; version: number; outcomeEvidenceRefs: string[]; briefing?: { facts: Array<{ statement: string; evidenceRefs: string[] }>; inferences: Array<{ statement: string; confidence: number; evidenceRefs: string[] }>; proposals: Array<{ statement: string }>; degraded: boolean; excludedDataScopes: string[] } };
type Cadence = { id: string; name: string; cadenceType: string; frequency: string; ownerId: string; status: string; nextOccurrenceAt: string; agendaTemplate: string[]; evidenceRequirements: string[]; nextOccurrence?: Occurrence };
type MetricProfile = { id: string; metricId: string; businessDefinition: string; formula: string; ownerId: string; stewardId: string; authoritativeSource: string; sourceLocator: string; refreshCadence: string; freshnessSlaMinutes: number; dimensions: string[]; allowedUses: string[]; prohibitedUses: string[]; version: number; latestQuality?: Quality };
type Scenario = { id: string; portfolioId: string; name: string; assumptions: string[]; projectDecisions: Array<{ projectId: string; action: string; capacityPercent: number; rationale: string }>; expectedBenefit: number; estimatedCost: number; riskScore: number; evidenceRefs: string[]; status: string; version: number; selectedBy?: string; selectedAt?: string };
type EnterpriseCase = { id: string; code: string; caseType: string; title: string; description: string; severity: string; status: string; ownerId?: string; dueAt: string; slaMinutes: number; sourceType: string; sourceRef: string; relatedObjectRefs: string[]; evidenceRefs: string[]; version: number; slaStatus: "complete" | "overdue" | "within_sla" };
type AiScorecard = { status: "insufficient_data" | "healthy" | "watch" | "at_risk"; sampleSize: number; passRate: number | null; averageScores: null | { groundedness: number; citationCorrectness: number; policyCorrectness: number; taskCompletion: number }; totalCostMicrounits: number; p95LatencyMs: number | null; unknownCount: number };
type Evaluation = { id: string; capabilityId: string; provider: string; model: string; promptVersion: string; datasetRef: string; outcome: string; scores: NonNullable<AiScorecard["averageScores"]>; latencyMs: number; costMicrounits: number; evaluatedAt: string; evidenceRefs: string[] };
type Workspace = {
  dataMode: "production" | "development_fixture";
  cadences: Cadence[];
  occurrences: Occurrence[];
  metricProfiles: MetricProfile[];
  scenarios: Scenario[];
  cases: EnterpriseCase[];
  aiGovernance: AiScorecard;
  recentEvaluations: Evaluation[];
  pendingChannelActions: number;
  exceptionSummary: { overdueCases: number; criticalCases: number; staleMetrics: number; unpreparedCadences: number };
  generatedAt: string;
};

type Tab = "cadence" | "metrics" | "portfolio" | "cases" | "ai" | "wecom";
const tabs: Array<{ id: Tab; label: string; icon: typeof Activity }> = [
  { id: "cadence", label: "管理节奏", icon: CalendarClock },
  { id: "metrics", label: "指标口径", icon: Database },
  { id: "portfolio", label: "组合情景", icon: Scale },
  { id: "cases", label: "企业事项", icon: ClipboardCheck },
  { id: "ai", label: "AI 治理", icon: Bot },
  { id: "wecom", label: "企业微信", icon: MessageSquareText },
];

const statusLabel: Record<string, string> = {
  scheduled: "待准备", preparing: "准备中", ready: "事实包就绪", in_progress: "进行中", awaiting_evidence: "待补证据", closed: "已关闭", cancelled: "已取消",
  draft: "草案", recommended: "建议方案", selected: "已选定", rejected: "已否决", superseded: "已替代",
  open: "待分诊", triaged: "已分诊", resolved: "已解决", healthy: "健康", stale: "已过期", missing: "缺失", unverified: "待核验",
  insufficient_data: "样本不足", watch: "观察", at_risk: "高风险", complete: "已完成", overdue: "已逾期", within_sla: "SLA 内",
};
const fmt = (value?: string) => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "—";
const textValue = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const splitLines = (value: string) => value.split(/[\n，,]/).map((item) => item.trim()).filter(Boolean);
const iso = (value: string) => new Date(value).toISOString();

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "请求未完成，请稍后重试。");
  return payload.data as T;
}

function StatePanel({ kind, onRetry }: { kind: "loading" | "error" | "empty"; onRetry?: () => void }) {
  const copy = kind === "loading" ? ["正在加载经营事实", "正在按当前身份与租户重新计算授权范围。"] : kind === "error" ? ["经营工作区暂时不可用", "数据没有被替换为缓存结果，请检查服务后重试。"] : ["授权范围内暂无对象", "可从相应页签创建第一个管理对象。"];
  return <div className={`mi-state mi-state-${kind}`}>{kind === "loading" ? <LoaderCircle className="spin" /> : <CircleAlert />}<strong>{copy[0]}</strong><p>{copy[1]}</p>{onRetry ? <button onClick={onRetry}><RefreshCw size={14} />重试</button> : null}</div>;
}

function Badge({ value }: { value: string }) { return <span className={`mi-badge mi-${value}`}>{statusLabel[value] ?? value}</span>; }

export function ManagementIntelligenceView({ actorId, onNotice }: { actorId: string | null; onNotice: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("cadence");
  const [data, setData] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [caseEvidence, setCaseEvidence] = useState("");
  const [cadenceEvidence, setCadenceEvidence] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await api<Workspace>("/api/v1/management-intelligence/workspace", { cache: "no-store" })); }
    catch (cause) { setData(null); setError(cause instanceof Error ? cause.message : "加载失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const mutate = useCallback(async (key: string, url: string, method: "POST" | "PUT", body?: unknown, message = "操作已完成") => {
    if (busy) return;
    setBusy(key);
    try {
      await api(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      onNotice(message);
      await load();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(""); }
  }, [busy, load, onNotice]);

  const attentionCount = useMemo(() => data ? Object.values(data.exceptionSummary).reduce((sum, value) => sum + value, 0) : 0, [data]);
  if (loading && !data) return <StatePanel kind="loading" />;
  if (error || !data) return <StatePanel kind="error" onRetry={() => void load()} />;

  return <div className="mi-view">
    <header className="mi-hero">
      <div><p className="mi-eyebrow">ENTERPRISE OPERATING SYSTEM · v0.13</p><h1>经营中枢</h1><p>把分散的信息变成可核验事实，把管理判断变成有责任、有时限、有证据的企业行动。</p></div>
      <div className={`mi-attention ${attentionCount ? "has-attention" : ""}`}><Activity size={16} /><span><strong>{attentionCount}</strong><small>当前管理例外</small></span></div>
    </header>

    {data.dataMode === "development_fixture" ? <div className="mi-fixture"><FileWarning size={16} /><span><strong>开发验证数据</strong> 当前对象用于本地功能验证，不代表企业生产事实；企业微信派发也不会触达真实成员。</span></div> : null}

    <section className="mi-loop" aria-label="企业管理闭环">
      {[{ icon: Database, label: "事实", detail: "来源与口径" }, { icon: Sparkles, label: "判断", detail: "引用与置信度" }, { icon: Scale, label: "决策", detail: "人类确认" }, { icon: Target, label: "行动", detail: "责任与 SLA" }, { icon: ShieldCheck, label: "证据", detail: "结果与审计" }].map((item, index, all) => {
        const Icon = item.icon;
        return <div key={item.label} className="mi-loop-step"><span><Icon size={15} /></span><div><strong>{item.label}</strong><small>{item.detail}</small></div>{index < all.length - 1 ? <ArrowRight className="mi-loop-arrow" size={14} /> : null}</div>;
      })}
    </section>

    <section className="mi-exceptions" aria-label="管理例外摘要">
      <div><small>逾期事项</small><strong>{data.exceptionSummary.overdueCases}</strong></div>
      <div><small>关键事项</small><strong>{data.exceptionSummary.criticalCases}</strong></div>
      <div><small>失鲜指标</small><strong>{data.exceptionSummary.staleMetrics}</strong></div>
      <div><small>24h 内待准备</small><strong>{data.exceptionSummary.unpreparedCadences}</strong></div>
      <button onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} />刷新事实</button>
    </section>

    <nav className="mi-tabs" aria-label="经营中枢模块">
      {tabs.map((item) => { const Icon = item.icon; return <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><Icon size={15} />{item.label}{item.id === "cases" && data.exceptionSummary.overdueCases ? <b>{data.exceptionSummary.overdueCases}</b> : null}</button>; })}
    </nav>

    <main className="mi-workbench">
      {tab === "cadence" ? <CadencePanel data={data} actorId={actorId} busy={busy} evidence={cadenceEvidence} setEvidence={setCadenceEvidence} mutate={mutate} /> : null}
      {tab === "metrics" ? <MetricPanel data={data} actorId={actorId} busy={busy} mutate={mutate} /> : null}
      {tab === "portfolio" ? <PortfolioPanel data={data} busy={busy} mutate={mutate} /> : null}
      {tab === "cases" ? <CasePanel data={data} actorId={actorId} busy={busy} evidence={caseEvidence} setEvidence={setCaseEvidence} mutate={mutate} /> : null}
      {tab === "ai" ? <AiPanel data={data} busy={busy} mutate={mutate} /> : null}
      {tab === "wecom" ? <WecomPanel data={data} busy={busy} mutate={mutate} /> : null}
    </main>
  </div>;
}

type Mutate = (key: string, url: string, method: "POST" | "PUT", body?: unknown, message?: string) => Promise<void>;

function CadencePanel({ data, actorId, busy, evidence, setEvidence, mutate }: { data: Workspace; actorId: string | null; busy: string; evidence: string; setEvidence: (value: string) => void; mutate: Mutate }) {
  const transition = (item: Occurrence, targetStatus: string) => mutate(`occ-${item.id}`, `/api/v1/management-intelligence/occurrences/${item.id}/transition`, "POST", { targetStatus, version: item.version, evidenceRefs: targetStatus === "closed" ? splitLines(evidence) : [] }, `节奏实例已推进为「${statusLabel[targetStatus]}」`);
  const submitCadence = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!actorId) return;
    const form = new FormData(event.currentTarget);
    void mutate("create-cadence", "/api/v1/management-intelligence/cadences", "POST", {
      name: textValue(form, "name"), cadenceType: textValue(form, "cadenceType"), frequency: textValue(form, "frequency"), timezone: "Asia/Shanghai", ownerId: actorId,
      participantRoleIds: splitLines(textValue(form, "roles")), agendaTemplate: splitLines(textValue(form, "agenda")), evidenceRequirements: splitLines(textValue(form, "requirements")), nextOccurrenceAt: iso(textValue(form, "nextOccurrenceAt")),
    }, "管理节奏已创建");
  };
  const submitOccurrence = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const cadenceId = textValue(form, "cadenceId");
    void mutate("create-occurrence", `/api/v1/management-intelligence/cadences/${cadenceId}/occurrences`, "POST", { scheduledStartAt: iso(textValue(form, "start")), scheduledEndAt: iso(textValue(form, "end")) }, "节奏实例已排期");
  };
  return <div className="mi-two-columns">
    <section className="mi-panel mi-panel-main"><div className="mi-panel-head"><div><CalendarClock /><span><h2>管理节奏</h2><p>会议不是日历事件，而是事实、决策和证据的周期性控制点。</p></span></div><b>{data.cadences.length} 套节奏</b></div>
      <div className="mi-record-list">{data.cadences.length ? data.cadences.map((cadence) => {
        const item = cadence.nextOccurrence;
        return <article key={cadence.id} className="mi-record"><header><div><span className="mi-code">{cadence.cadenceType}</span><h3>{cadence.name}</h3><p>{cadence.agendaTemplate.join(" · ")}</p></div><Badge value={item?.status ?? cadence.status} /></header>
          <div className="mi-record-meta"><span>下次开始 <strong>{fmt(item?.scheduledStartAt ?? cadence.nextOccurrenceAt)}</strong></span><span>责任人 <strong>{cadence.ownerId.slice(0, 8)}</strong></span><span>证据要求 <strong>{cadence.evidenceRequirements.length} 项</strong></span></div>
          {item?.briefing ? <div className="mi-briefing"><div><b>事实包</b>{item.briefing.facts.slice(0, 3).map((fact) => <p key={fact.statement}>{fact.statement}<small>{fact.evidenceRefs.join(" · ")}</small></p>)}</div><div><b>Agent 判断 {item.briefing.degraded ? "· 降级" : ""}</b>{item.briefing.inferences.slice(0, 2).map((inference) => <p key={inference.statement}>{inference.statement}<small>置信度 {Math.round(inference.confidence * 100)}% · {inference.evidenceRefs.join(" · ")}</small></p>)}</div><div><b>待人确认</b>{item.briefing.proposals.slice(0, 2).map((proposal) => <p key={proposal.statement}>{proposal.statement}</p>)}</div></div> : null}
          {item ? <footer className="mi-actions">
            {item.status === "scheduled" ? <button className="mi-primary" disabled={!!busy} onClick={() => void mutate(`occ-${item.id}`, `/api/v1/management-intelligence/occurrences/${item.id}/prepare`, "POST", undefined, "事实包已准备；所有判断仍需人类确认")}>{busy === `occ-${item.id}` ? <LoaderCircle className="spin" /> : <Sparkles />}AI 准备事实包</button> : null}
            {item.status === "ready" ? <button className="mi-primary" disabled={!!busy} onClick={() => void transition(item, "in_progress")}><Check />开始会议</button> : null}
            {item.status === "in_progress" ? <button disabled={!!busy} onClick={() => void transition(item, "awaiting_evidence")}><ClipboardCheck />进入补证</button> : null}
            {item.status === "awaiting_evidence" ? <><input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="结果证据引用（关闭前必填）" /><button className="mi-primary" disabled={!!busy || !evidence.trim()} onClick={() => void transition(item, "closed")}><ShieldCheck />核证关闭</button></> : null}
          </footer> : null}
        </article>;
      }) : <StatePanel kind="empty" />}</div>
    </section>
    <aside className="mi-stack">
      <details className="mi-form-card"><summary><Plus size={15} />新建管理节奏</summary><form onSubmit={submitCadence}><label>节奏名称<input name="name" required placeholder="例如：月度经营复盘" /></label><div className="mi-form-row"><label>类型<select name="cadenceType"><option value="weekly_operations">周运营会</option><option value="monthly_business">月经营会</option><option value="quarterly_strategy">季战略会</option><option value="custom">自定义</option></select></label><label>频率<select name="frequency"><option value="weekly">每周</option><option value="monthly">每月</option><option value="quarterly">每季</option><option value="daily">每日</option></select></label></div><label>下次发生<input name="nextOccurrenceAt" type="datetime-local" required /></label><label>参与角色<textarea name="roles" required placeholder="每行一个角色，如 pmo" /></label><label>议程模板<textarea name="agenda" required placeholder="核对指标新鲜度&#10;确认关键事项&#10;形成决策" /></label><label>结果证据要求<textarea name="requirements" required placeholder="会议纪要&#10;决定与行动项" /></label><button className="mi-primary" disabled={!actorId || !!busy}>{busy === "create-cadence" ? <LoaderCircle className="spin" /> : <Plus />}创建节奏</button></form></details>
      <details className="mi-form-card"><summary><CalendarClock size={15} />排期一个实例</summary><form onSubmit={submitOccurrence}><label>管理节奏<select name="cadenceId" required>{data.cadences.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>开始<input name="start" type="datetime-local" required /></label><label>结束<input name="end" type="datetime-local" required /></label><button className="mi-primary" disabled={!data.cadences.length || !!busy}>{busy === "create-occurrence" ? <LoaderCircle className="spin" /> : <CalendarClock />}确认排期</button></form></details>
    </aside>
  </div>;
}

function MetricPanel({ data, actorId, busy, mutate }: { data: Workspace; actorId: string | null; busy: string; mutate: Mutate }) {
  const quality = (event: FormEvent<HTMLFormElement>, metricId: string) => { event.preventDefault(); const form = new FormData(event.currentTarget); void mutate(`quality-${metricId}`, `/api/v1/management-intelligence/metrics/${metricId}/quality-checks`, "POST", { observedAt: iso(textValue(form, "observedAt")), completenessPercent: Number(textValue(form, "completeness")), evidenceRefs: splitLines(textValue(form, "evidence")) }, "指标质量检查已记录"); };
  const profile = (event: FormEvent<HTMLFormElement>, item: MetricProfile) => { event.preventDefault(); if (!actorId) return; const form = new FormData(event.currentTarget); void mutate(`profile-${item.metricId}`, `/api/v1/management-intelligence/metrics/${item.metricId}/semantic-profile`, "PUT", { businessDefinition: textValue(form, "definition"), formula: textValue(form, "formula"), ownerId: item.ownerId || actorId, stewardId: item.stewardId || actorId, authoritativeSource: textValue(form, "source"), sourceLocator: textValue(form, "locator"), refreshCadence: textValue(form, "cadence"), freshnessSlaMinutes: Number(textValue(form, "sla")), dimensions: splitLines(textValue(form, "dimensions")), allowedUses: splitLines(textValue(form, "allowed")), prohibitedUses: splitLines(textValue(form, "prohibited")), version: item.version }, "指标口径已更新"); };
  return <section className="mi-panel"><div className="mi-panel-head"><div><Database /><span><h2>指标语义与质量</h2><p>每个数字都必须说明“是什么、从哪里来、多久算过期、可以用于什么”。</p></span></div><b>{data.metricProfiles.length} 个受管指标</b></div><div className="mi-metric-table">{data.metricProfiles.length ? data.metricProfiles.map((item) => <article key={item.id} className="mi-metric-row"><div className="mi-metric-title"><span><strong>{item.metricId.slice(0, 8)}</strong><small>{item.authoritativeSource}</small></span><Badge value={item.latestQuality?.status ?? "missing"} /></div><div className="mi-definition"><b>业务定义</b><p>{item.businessDefinition}</p><small>{item.formula}</small></div><div className="mi-quality-facts"><span>新鲜度 SLA<strong>{item.freshnessSlaMinutes} 分钟</strong></span><span>最新检查<strong>{fmt(item.latestQuality?.checkedAt)}</strong></span><span>完整度<strong>{item.latestQuality?.completenessPercent ?? "—"}%</strong></span></div><details className="mi-inline-form"><summary>执行质量检查</summary><form onSubmit={(event) => quality(event, item.metricId)}><input name="observedAt" type="datetime-local" required aria-label="数据观测时间" /><input name="completeness" type="number" min="0" max="100" required placeholder="完整度 %" /><input name="evidence" required placeholder="检查证据引用" /><button className="mi-primary" disabled={!!busy}>{busy === `quality-${item.metricId}` ? <LoaderCircle className="spin" /> : <Activity />}记录检查</button></form></details><details className="mi-inline-form"><summary>维护业务口径</summary><form className="mi-profile-form" onSubmit={(event) => profile(event, item)}><label>业务定义<textarea name="definition" defaultValue={item.businessDefinition} required /></label><label>计算公式<textarea name="formula" defaultValue={item.formula} required /></label><div className="mi-form-row"><label>权威来源<input name="source" defaultValue={item.authoritativeSource} required /></label><label>来源定位<input name="locator" defaultValue={item.sourceLocator} required /></label></div><div className="mi-form-row"><label>刷新频率<select name="cadence" defaultValue={item.refreshCadence}><option value="realtime">实时</option><option value="daily">每日</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="quarterly">每季</option></select></label><label>新鲜度 SLA（分钟）<input name="sla" type="number" min="1" defaultValue={item.freshnessSlaMinutes} required /></label></div><label>分析维度<input name="dimensions" defaultValue={item.dimensions.join("，")} /></label><label>允许用途<input name="allowed" defaultValue={item.allowedUses.join("，")} required /></label><label>禁止用途<input name="prohibited" defaultValue={item.prohibitedUses.join("，")} required /></label><button className="mi-primary" disabled={!!busy}>{busy === `profile-${item.metricId}` ? <LoaderCircle className="spin" /> : <ShieldCheck />}保存口径版本</button></form></details></article>) : <StatePanel kind="empty" />}</div></section>;
}

function PortfolioPanel({ data, busy, mutate }: { data: Workspace; busy: string; mutate: Mutate }) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const portfolioId = textValue(form, "portfolioId"); void mutate("create-scenario", `/api/v1/management-intelligence/portfolios/${portfolioId}/scenarios`, "POST", { name: textValue(form, "name"), assumptions: splitLines(textValue(form, "assumptions")), projectDecisions: [{ projectId: textValue(form, "projectId"), action: textValue(form, "action"), capacityPercent: Number(textValue(form, "capacity")), rationale: textValue(form, "rationale") }], expectedBenefit: Number(textValue(form, "benefit")), estimatedCost: Number(textValue(form, "cost")), riskScore: Number(textValue(form, "risk")), evidenceRefs: splitLines(textValue(form, "evidence")), status: "draft" }, "组合情景已创建"); };
  return <div className="mi-two-columns"><section className="mi-panel mi-panel-main"><div className="mi-panel-head"><div><Scale /><span><h2>项目组合情景</h2><p>先把假设、容量、收益、成本和风险摆在同一张决策纸上，再由有权的人选定。</p></span></div><b>{data.scenarios.length} 个方案</b></div><div className="mi-scenario-list">{data.scenarios.length ? data.scenarios.map((item) => <article key={item.id} className={`mi-scenario mi-scenario-${item.status}`}><header><div><span className="mi-code">{item.portfolioId.slice(0, 8)}</span><h3>{item.name}</h3></div><Badge value={item.status} /></header><div className="mi-scenario-numbers"><span>预期收益<strong>{item.expectedBenefit}</strong></span><span>估算成本<strong>{item.estimatedCost}</strong></span><span>风险评分<strong>{item.riskScore}/25</strong></span></div><div className="mi-assumptions"><b>关键假设</b>{item.assumptions.map((assumption) => <p key={assumption}>{assumption}</p>)}</div>{item.projectDecisions.map((decision) => <div className="mi-decision-line" key={`${item.id}-${decision.projectId}`}><span>{decision.action}</span><strong>{decision.capacityPercent}% 容量</strong><p>{decision.rationale}</p></div>)}<footer><small>证据：{item.evidenceRefs.join(" · ")}</small>{["draft", "recommended"].includes(item.status) ? <button className="mi-primary" disabled={!!busy} onClick={() => void mutate(`scenario-${item.id}`, `/api/v1/management-intelligence/scenarios/${item.id}/select`, "POST", { version: item.version }, "组合情景已由当前身份选定")}>{busy === `scenario-${item.id}` ? <LoaderCircle className="spin" /> : <Check />}选定情景</button> : null}</footer></article>) : <StatePanel kind="empty" />}</div></section><aside className="mi-stack"><details className="mi-form-card" open={!data.scenarios.length}><summary><Plus size={15} />创建比较情景</summary><form onSubmit={submit}><label>组合 ID<input name="portfolioId" defaultValue={data.scenarios[0]?.portfolioId} required /></label><label>情景名称<input name="name" required /></label><label>关键假设<textarea name="assumptions" required placeholder="每行一个可检验假设" /></label><label>项目 ID<input name="projectId" required /></label><div className="mi-form-row"><label>动作<select name="action"><option value="continue">继续</option><option value="accelerate">加速</option><option value="pause">暂停</option><option value="stop">停止</option><option value="start">启动</option></select></label><label>容量 %<input name="capacity" type="number" min="0" max="100" required /></label></div><label>取舍理由<textarea name="rationale" required /></label><div className="mi-form-row"><label>收益<input name="benefit" type="number" min="0" required /></label><label>成本<input name="cost" type="number" min="0" required /></label></div><label>风险（1-25）<input name="risk" type="number" min="1" max="25" required /></label><label>证据引用<input name="evidence" required /></label><button className="mi-primary" disabled={!!busy}>{busy === "create-scenario" ? <LoaderCircle className="spin" /> : <Plus />}保存情景</button></form></details><div className="mi-dark-note"><Scale /><div><strong>情景不是预测结果</strong><p>它是一组可审计假设。选定动作仍需经过权限、资源和后续证据校验。</p></div></div></aside></div>;
}

function CasePanel({ data, actorId, busy, evidence, setEvidence, mutate }: { data: Workspace; actorId: string | null; busy: string; evidence: string; setEvidence: (value: string) => void; mutate: Mutate }) {
  const change = (item: EnterpriseCase, targetStatus: string) => mutate(`case-${item.id}`, `/api/v1/management-intelligence/cases/${item.id}/transition`, "POST", { targetStatus, version: item.version, ownerId: targetStatus === "in_progress" || ["resolved", "closed"].includes(targetStatus) ? item.ownerId ?? actorId ?? undefined : undefined, evidenceRefs: ["resolved", "closed"].includes(targetStatus) ? splitLines(evidence) : [] }, `事项已推进为「${statusLabel[targetStatus]}」`);
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void mutate("create-case", "/api/v1/management-intelligence/cases", "POST", { caseType: textValue(form, "caseType"), title: textValue(form, "title"), description: textValue(form, "description"), severity: textValue(form, "severity"), ownerId: actorId || undefined, dueAt: iso(textValue(form, "dueAt")), slaMinutes: Number(textValue(form, "slaMinutes")), sourceType: "web", sourceRef: textValue(form, "sourceRef"), relatedObjectRefs: splitLines(textValue(form, "related")), evidenceRefs: splitLines(textValue(form, "evidence")) }, "企业事项已登记"); };
  return <div className="mi-two-columns"><section className="mi-panel mi-panel-main"><div className="mi-panel-head"><div><ClipboardCheck /><span><h2>企业事项</h2><p>跨项目、客户、质量和合规问题统一进入有编码、有 Owner、有 SLA 的处理案卷。</p></span></div><b>{data.cases.filter((item) => !["closed", "cancelled"].includes(item.status)).length} 个打开事项</b></div><div className="mi-case-list">{data.cases.length ? data.cases.map((item) => <article key={item.id} className={`mi-case severity-${item.severity}`}><div className="mi-case-severity" /><header><div><span className="mi-code">{item.code}</span><h3>{item.title}</h3><p>{item.description}</p></div><div><Badge value={item.status} /><Badge value={item.slaStatus} /></div></header><div className="mi-record-meta"><span>严重度 <strong>{item.severity}</strong></span><span>Owner <strong>{item.ownerId?.slice(0, 8) ?? "待认领"}</strong></span><span>到期 <strong>{fmt(item.dueAt)}</strong></span><span>来源 <strong>{item.sourceRef}</strong></span></div>{item.evidenceRefs.length ? <small className="mi-evidence">证据：{item.evidenceRefs.join(" · ")}</small> : null}<footer className="mi-actions">{item.status === "open" ? <button disabled={!!busy} onClick={() => void change(item, "triaged")}>完成分诊</button> : null}{["open", "triaged"].includes(item.status) ? <button className="mi-primary" disabled={!!busy || !actorId} onClick={() => void change(item, "in_progress")}><Target />接单处理</button> : null}{item.status === "in_progress" ? <><input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="解决证据引用（必填）" /><button className="mi-primary" disabled={!!busy || !evidence.trim()} onClick={() => void change(item, "resolved")}><ShieldCheck />核证解决</button></> : null}{item.status === "resolved" ? <button className="mi-primary" disabled={!!busy} onClick={() => void change(item, "closed")}><Check />关闭案卷</button> : null}</footer></article>) : <StatePanel kind="empty" />}</div></section><aside className="mi-stack"><details className="mi-form-card" open={!data.cases.length}><summary><Plus size={15} />登记企业事项</summary><form onSubmit={submit}><div className="mi-form-row"><label>类型<select name="caseType"><option value="operational_exception">运营例外</option><option value="customer_issue">客户问题</option><option value="compliance">合规事项</option><option value="quality">质量事项</option><option value="service_request">服务请求</option><option value="other">其他</option></select></label><label>严重度<select name="severity"><option value="medium">中</option><option value="high">高</option><option value="critical">关键</option><option value="low">低</option></select></label></div><label>标题<input name="title" required /></label><label>事实描述<textarea name="description" required /></label><label>处理期限<input name="dueAt" type="datetime-local" required /></label><label>SLA（分钟）<input name="slaMinutes" type="number" min="1" defaultValue="1440" required /></label><label>来源引用<input name="sourceRef" required placeholder="例如 project:uuid" /></label><label>关联对象<input name="related" placeholder="每行一个引用" /></label><label>初始证据<input name="evidence" placeholder="可选，不能用主观判断代替" /></label><button className="mi-primary" disabled={!actorId || !!busy}>{busy === "create-case" ? <LoaderCircle className="spin" /> : <Plus />}登记事项</button></form></details></aside></div>;
}

function AiPanel({ data, busy, mutate }: { data: Workspace; busy: string; mutate: Mutate }) {
  const score = data.aiGovernance;
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const number = (name: string) => Number(textValue(form, name)); void mutate("record-eval", "/api/v1/management-intelligence/ai/evaluations", "POST", { capabilityId: textValue(form, "capability"), provider: textValue(form, "provider"), model: textValue(form, "model"), promptVersion: textValue(form, "promptVersion"), datasetRef: textValue(form, "dataset"), outcome: textValue(form, "outcome"), scores: { groundedness: number("groundedness"), citationCorrectness: number("citation"), policyCorrectness: number("policy"), taskCompletion: number("completion") }, inputTokens: number("inputTokens"), outputTokens: number("outputTokens"), latencyMs: number("latency"), costMicrounits: number("cost"), evidenceRefs: splitLines(textValue(form, "evidence")), evaluatedAt: new Date().toISOString() }, "AI 治理评测已记录"); };
  return <div className="mi-two-columns"><section className="mi-panel mi-panel-main"><div className="mi-panel-head"><div><Bot /><span><h2>AI 质量与治理</h2><p>AI 是否可用，以引用正确性、策略正确性、任务完成度和样本量共同判断。</p></span></div><Badge value={score.status} /></div><div className="mi-scorecard"><div className="mi-score-main"><small>通过率</small><strong>{score.passRate === null ? "—" : `${Math.round(score.passRate * 100)}%`}</strong><span>{score.sampleSize < 3 ? "至少 3 个样本后才给出健康判断" : `${score.sampleSize} 个受控评测样本`}</span></div><div className="mi-score-facts"><span>策略正确性<strong>{score.averageScores ? `${Math.round(score.averageScores.policyCorrectness * 100)}%` : "—"}</strong></span><span>引用正确性<strong>{score.averageScores ? `${Math.round(score.averageScores.citationCorrectness * 100)}%` : "—"}</strong></span><span>P95 延迟<strong>{score.p95LatencyMs === null ? "—" : `${score.p95LatencyMs}ms`}</strong></span><span>结果未知<strong>{score.unknownCount}</strong></span></div></div><div className="mi-evaluation-list"><h3>近期评测证据</h3>{data.recentEvaluations.length ? data.recentEvaluations.map((item) => <article key={item.id}><Badge value={item.outcome} /><div><strong>{item.capabilityId}</strong><small>{item.provider} / {item.model} · Prompt {item.promptVersion}</small></div><span><b>{Math.round(item.scores.policyCorrectness * 100)}%</b><small>策略正确</small></span><p>{item.datasetRef}<small>{item.evidenceRefs.join(" · ")}</small></p></article>) : <StatePanel kind="empty" />}</div></section><aside className="mi-stack"><details className="mi-form-card" open={score.sampleSize < 3}><summary><Plus size={15} />记录受控评测</summary><form onSubmit={submit}><label>能力 ID<input name="capability" required placeholder="management.briefing" /></label><div className="mi-form-row"><label>服务商<input name="provider" required /></label><label>模型<input name="model" required /></label></div><div className="mi-form-row"><label>Prompt 版本<input name="promptVersion" required /></label><label>结果<select name="outcome"><option value="passed">通过</option><option value="failed">失败</option><option value="unknown">未知</option></select></label></div><label>评测集引用<input name="dataset" required /></label><div className="mi-score-inputs"><label>有依据<input name="groundedness" type="number" min="0" max="1" step="0.01" required /></label><label>引用<input name="citation" type="number" min="0" max="1" step="0.01" required /></label><label>策略<input name="policy" type="number" min="0" max="1" step="0.01" required /></label><label>完成度<input name="completion" type="number" min="0" max="1" step="0.01" required /></label></div><div className="mi-form-row"><label>输入 Token<input name="inputTokens" type="number" min="0" required /></label><label>输出 Token<input name="outputTokens" type="number" min="0" required /></label></div><div className="mi-form-row"><label>延迟 ms<input name="latency" type="number" min="0" required /></label><label>成本微单位<input name="cost" type="number" min="0" required /></label></div><label>评测证据<input name="evidence" required /></label><button className="mi-primary" disabled={!!busy}>{busy === "record-eval" ? <LoaderCircle className="spin" /> : <ShieldCheck />}保存评测证据</button></form></details><div className="mi-dark-note"><ShieldCheck /><div><strong>样本不足时拒绝下结论</strong><p>未知结果不计为成功；高风险能力应使用固定评测集和可追溯 Prompt 版本。</p></div></div></aside></div>;
}

function WecomPanel({ data, busy, mutate }: { data: Workspace; busy: string; mutate: Mutate }) {
  const resources = [...data.cases.filter((item) => ["open", "triaged"].includes(item.status)).map((item) => ({ id: item.id, type: "case_accept", label: `事项接单 · ${item.code} ${item.title}` })), ...data.occurrences.filter((item) => item.status === "ready").map((item) => ({ id: item.id, type: "cadence_start", label: `开始会议 · ${fmt(item.scheduledStartAt)}` }))];
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const value = textValue(form, "resource"); const [actionType, resourceId] = value.split(":"); void mutate("dispatch-wecom", "/api/v1/management-intelligence/wecom/actions", "POST", { actionType, resourceId, connectionId: textValue(form, "connectionId"), externalUserId: textValue(form, "externalUserId"), expiresInMinutes: Number(textValue(form, "expires")) }, "企业微信动作已进入投递链路；最终状态以回执为准"); };
  return <div className="mi-wecom"><section className="mi-panel"><div className="mi-panel-head"><div><MessageSquareText /><span><h2>企业微信轻处置面</h2><p>只推送需要及时确认的动作；复杂事实、比较和审计仍回到网页端完成。</p></span></div><b>{data.pendingChannelActions} 个待确认动作</b></div><div className="mi-channel-flow"><div><span>1</span><strong>网页选择对象</strong><small>校验当前状态与版本</small></div><ArrowRight /><div><span>2</span><strong>企业微信卡片</strong><small>短时效、指定接收人</small></div><ArrowRight /><div><span>3</span><strong>身份重算</strong><small>回调时重新映射权限</small></div><ArrowRight /><div><span>4</span><strong>原子回写</strong><small>业务对象与动作同事务</small></div></div><form className="mi-wecom-form" onSubmit={submit}><label>企业微信连接 ID<input name="connectionId" required defaultValue={data.dataMode === "development_fixture" ? "a5000000-0000-4000-8000-000000000001" : ""} placeholder="已激活的 WeCom connection UUID" /></label><label>外部成员 ID<input name="externalUserId" required defaultValue={data.dataMode === "development_fixture" ? "demo-manager" : ""} autoComplete="off" /><small>仅用于即时投递；平台持久化时只保存 SHA-256 摘要。</small></label><label>受控动作<select name="resource" required>{resources.length ? resources.map((item) => <option key={`${item.type}:${item.id}`} value={`${item.type}:${item.id}`}>{item.label}</option>) : <option value="">当前没有可派发对象</option>}</select></label><label>确认有效期<select name="expires" defaultValue="10"><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option></select></label><button className="mi-primary" disabled={!resources.length || !!busy}>{busy === "dispatch-wecom" ? <LoaderCircle className="spin" /> : <Send />}派发确认卡片</button></form></section><aside className="mi-channel-guard"><ShieldCheck /><div><h3>动作安全边界</h3><p>卡片不携带权限结论。回调经过平台签名验证、身份映射、当前权限重算、接收人摘要比对、提案哈希和对象版本校验。</p><ul><li>明文接收人 ID 不入业务表</li><li>过期、重放、版本变化均拒绝执行</li><li>重复回调返回同一执行结果</li><li>所有状态变化写入原子审计</li></ul></div></aside></div>;
}
