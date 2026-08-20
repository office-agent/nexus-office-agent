"use client";

import { Activity, ArrowRight, Bot, BriefcaseBusiness, CheckCircle2, Gauge, Goal, Network, RefreshCw, ShieldCheck, Target, UserRoundCheck, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type MetricState = {
  metric: { id: string; name: string; unit: string; targetValue: number; sourceSystem: string };
  observation: { value: number; sourceRef: string; sourceType: string; observedAt: string };
  progress: number | null;
  health: "on_target" | "watch" | "at_risk" | "unknown";
};
type Objective = {
  id: string; title: string; objectiveType: "okr" | "kpi"; status: string; measurementMethod: string; dataSource: string;
  reviewCadence: string; projectIds: string[]; progress: number | null; metricStates: MetricState[];
};
type Review = {
  id: string; title: string; status: "draft" | "pending_confirmation" | "confirmed"; version: number;
  facts: Array<{ statement: string; evidenceRefs: string[] }>;
  inferences: Array<{ statement: string; confidence: number; evidenceRefs: string[] }>;
  decisions: string[]; excludedDataScopes: string[];
};
type Workspace = {
  themes: Array<{ id: string; name: string; description: string }>;
  objectives: Objective[];
  metrics: Array<{ id: string; name: string; unit: string; latestObservation?: { value: number }; health: string }>;
  portfolios: Array<{ id: string; name: string; projectIds: string[]; investmentThesis: string }>;
  reviews: Review[];
  responsibilities: Array<{ id: string; resourceId: string; role: string; subjectId: string }>;
  capacity: Array<{ id: string; userId: string; utilizationPercent: number; allocatedHours: number; availableHours: number; status: string; includedSignals: string[] }>;
  talent: { factCount: number; protectedRecordCount: number; policy: string };
};
type Insight = {
  facts: Array<{ statement: string; evidenceRefs: string[] }>;
  inferences: Array<{ statement: string; confidence: number; evidenceRefs: string[] }>;
  usedDataScopes: string[]; excludedDataScopes: string[]; stateChanged: false;
};
type TalentPack = {
  evidence: Array<{ id: string; statement: string; evidenceRefs: string[] }>;
  usedDataScopes: string[]; excludedDataScopes: string[]; gaps: string[]; stateChanged: false;
  score: null; rank: null; employmentRecommendation: null;
};

const healthLabel: Record<string, string> = { on_target: "达标", watch: "接近预警", at_risk: "偏离目标", unknown: "待数据" };
const cadenceLabel: Record<string, string> = { daily: "每日", weekly: "每周", monthly: "每月", quarterly: "每季度" };

export function EnterpriseIntelligenceView({ actorId, focus, onNotice }: { actorId: string | null; focus: "goals" | "insights" | "people"; onNotice: (message: string) => void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [insight, setInsight] = useState<Insight | null>(null);
  const [talent, setTalent] = useState<TalentPack | null>(null);
  const [working, setWorking] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/v1/enterprise-intelligence/workspace", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "经营工作区加载失败");
    setWorkspace(payload.data);
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/enterprise-intelligence/workspace", { cache: "no-store" })
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error?.message || "经营工作区加载失败");
        if (active) setWorkspace(payload.data);
      })
      .catch((error) => { if (active) onNotice(error instanceof Error ? error.message : "经营工作区加载失败"); });
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const review = workspace?.reviews[0];
  const atRiskCount = workspace?.objectives.filter(({ status }) => status === "at_risk").length ?? 0;
  const nearLimitCount = workspace?.capacity.filter(({ status }) => status === "near_limit" || status === "overloaded").length ?? 0;
  const heading = focus === "goals" ? "战略目标与指标树" : focus === "insights" ? "经营事实、推断与复盘" : "组织责任、容量与人才保护";

  async function prepareInsight() {
    setWorking("insight");
    try {
      const response = await fetch("/api/v1/enterprise-intelligence/insights/prepare", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "经营预判失败");
      setInsight(payload.data); onNotice("Agent 已生成经营预判，未改变任何正式指标或复盘状态");
    } catch (error) { onNotice(error instanceof Error ? error.message : "经营预判失败"); }
    finally { setWorking(""); }
  }

  async function confirmReview() {
    if (!review) return;
    setWorking("review");
    try {
      const response = await fetch(`/api/v1/enterprise-intelligence/reviews/${review.id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: review.version }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "复盘确认失败");
      await load(); onNotice("经营复盘已由责任人确认并写入审计事件");
    } catch (error) { onNotice(error instanceof Error ? error.message : "复盘确认失败"); }
    finally { setWorking(""); }
  }

  async function prepareTalent() {
    if (!actorId) return;
    setWorking("talent");
    try {
      const response = await fetch("/api/v1/enterprise-intelligence/talent/evidence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subjectUserId: actorId, purpose: "development_conversation" }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "人才证据整理失败");
      setTalent(payload.data); onNotice("只整理了权限内事实；没有评分、排名或雇佣建议");
    } catch (error) { onNotice(error instanceof Error ? error.message : "人才证据整理失败"); }
    finally { setWorking(""); }
  }

  const responsibilityByResource = useMemo(() => new Map(workspace?.responsibilities.map((item) => [item.resourceId, workspace.responsibilities.filter(({ resourceId }) => resourceId === item.resourceId)]) ?? []), [workspace]);

  return (
    <div className={`enterprise-view enterprise-focus-${focus}`}>
      <header className="enterprise-hero">
        <div><p className="eyebrow">MANAGEMENT OPERATING SYSTEM</p><h1>{heading}</h1><p>把战略、指标、项目、责任和经营复盘连成同一条证据链；AI 只解释和准备，人对正式状态与人才结论负责。</p></div>
        <span><ShieldCheck size={15} />事实、推断、提案与决定分层展示</span>
      </header>

      <section className="enterprise-kpis">
        <div><Target size={18} /><span><strong>{workspace?.themes.length ?? "—"}</strong><small>有效战略主题</small></span></div>
        <div><Goal size={18} /><span><strong>{workspace?.objectives.length ?? "—"}</strong><small>可追溯目标</small></span></div>
        <div><Activity size={18} /><span><strong>{atRiskCount || "0"}</strong><small>偏离目标</small></span></div>
        <div><Users size={18} /><span><strong>{nearLimitCount || "0"}</strong><small>容量接近上限</small></span></div>
      </section>

      <div className="enterprise-grid">
        <div className="enterprise-main">
          <section className="enterprise-card strategy-map-card">
            <div className="enterprise-card-head"><div><span><Network size={16} /></span><div><h2>战略到执行</h2><p>{workspace?.themes[0]?.name ?? "战略主题"} · 每个目标必须落到指标和项目</p></div></div><b>{workspace?.portfolios[0]?.name ?? "项目组合"}</b></div>
            <div className="objective-stack">
              {workspace?.objectives.map((objective) => {
                const raci = responsibilityByResource.get(objective.id) ?? [];
                return <article key={objective.id}>
                  <div className="objective-title"><span className={`objective-type type-${objective.objectiveType}`}>{objective.objectiveType.toUpperCase()}</span><div><strong>{objective.title}</strong><small>{cadenceLabel[objective.reviewCadence]}检查 · {objective.projectIds.length} 个承接项目 · A/R {raci.length || "待补"}</small></div><em>{objective.progress === null ? "—" : `${Math.round(objective.progress * 100)}%`}</em></div>
                  <div className="objective-progress"><i style={{ width: `${Math.round((objective.progress ?? 0) * 100)}%` }} /></div>
                  {objective.metricStates.map((state) => <div className="metric-line" key={state.metric.id}><span><Gauge size={13} />{state.metric.name}</span><b>{state.observation.value}{state.metric.unit} / {state.metric.targetValue}{state.metric.unit}</b><small className={`health-${state.health}`}>{healthLabel[state.health]}</small></div>)}
                  <footer><span>口径：{objective.measurementMethod}</span><span>来源：{objective.dataSource}</span></footer>
                </article>;
              })}
            </div>
          </section>

          <section className="enterprise-card review-card">
            <div className="enterprise-card-head"><div><span><BriefcaseBusiness size={16} /></span><div><h2>经营复盘</h2><p>事实可以同步，推断必须带置信度，决定必须由 Owner 确认</p></div></div>{review && <span className={`review-status review-${review.status}`}>{review.status === "confirmed" ? "已确认" : "待责任人确认"}</span>}</div>
            {review && <>
              <strong className="review-title">{review.title}</strong>
              <div className="review-columns"><div><span>已确认事实</span>{review.facts.map((fact) => <p key={fact.statement}><CheckCircle2 size={13} />{fact.statement}<small>{fact.evidenceRefs[0]}</small></p>)}</div><div><span>Agent 推断</span>{review.inferences.map((item) => <p key={item.statement}><Bot size={13} />{item.statement}<small>置信度 {Math.round(item.confidence * 100)}% · {item.evidenceRefs[0]}</small></p>)}</div></div>
              <div className="review-actions"><button onClick={() => void prepareInsight()} disabled={Boolean(working)}><Bot size={14} />{working === "insight" ? "分析中…" : "Agent 经营预判"}</button>{review.status !== "confirmed" ? <button className="decision-button" onClick={() => void confirmReview()} disabled={Boolean(working)}>人工确认复盘 <ArrowRight size={13} /></button> : <span><CheckCircle2 size={14} />复盘已锁定</span>}</div>
            </>}
          </section>

          {insight && <section className="enterprise-card agent-insight-card"><div className="agent-result-head"><Bot size={16} /><div><strong>Agent 经营预判</strong><small>只读分析 · 未改变指标或复盘状态</small></div></div><div className="insight-list">{insight.inferences.map((item) => <p key={item.statement}><span>推断 · {Math.round(item.confidence * 100)}%</span>{item.statement}<small>依据 {item.evidenceRefs.join(" · ")}</small></p>)}</div><footer><b>使用：</b>{insight.usedDataScopes.join("、")}<b>排除：</b>{insight.excludedDataScopes.join("、")}</footer></section>}
        </div>

        <aside className="enterprise-rail">
          <section className="enterprise-card responsibility-card">
            <div className="enterprise-card-head"><div><span><UserRoundCheck size={16} /></span><div><h2>责任与容量</h2><p>唯一 A、明确 R，负荷只用于规划</p></div></div></div>
            <div className="raci-row"><span><b>A</b>Accountable</span><strong>{workspace?.responsibilities.filter(({ role }) => role === "accountable").length ?? "—"} 个明确责任</strong></div>
            <div className="raci-row"><span><b>R</b>Responsible</span><strong>{workspace?.responsibilities.filter(({ role }) => role === "responsible").length ?? "—"} 个执行责任</strong></div>
            {workspace?.capacity.map((item) => <div className="capacity-block" key={item.id}><div><span>本周计划容量</span><strong>{item.utilizationPercent}%</strong></div><div className="capacity-bar"><i style={{ width: `${Math.min(item.utilizationPercent, 100)}%` }} /></div><small>{item.allocatedHours}/{item.availableHours}h · {item.status === "near_limit" ? "接近上限，建议调整" : item.status}</small></div>)}
            <div className="protection-note"><ShieldCheck size={14} /><span>仅使用计划分配、批准休假和项目责任；不采集在线时长、消息数或键盘活动。</span></div>
          </section>

          <section className="enterprise-card talent-guard-card">
            <div className="enterprise-card-head"><div><span><Users size={16} /></span><div><h2>人才保护边界</h2><p>证据整理不等于人员评价</p></div></div></div>
            <div className="talent-summary"><span><strong>{workspace?.talent.factCount ?? "—"}</strong>条权限内事实</span><span><strong>{workspace?.talent.protectedRecordCount ?? "—"}</strong>条受保护记录</span></div>
            <p>{workspace?.talent.policy}</p>
            <button onClick={() => void prepareTalent()} disabled={Boolean(working) || !actorId}><Bot size={14} />{working === "talent" ? "整理中…" : "准备我的发展沟通证据"}</button>
            {talent && <div className="talent-result"><div><CheckCircle2 size={14} /><strong>只读证据包 · 无评分/排名</strong></div>{talent.evidence.map((item) => <p key={item.id}>{item.statement}<small>{item.evidenceRefs.join(" · ")}</small></p>)}<footer>明确排除：{talent.excludedDataScopes.join("、")}</footer></div>}
          </section>

          <section className="portfolio-note"><RefreshCw size={15} /><div><strong>指标新鲜度</strong><p>每个数值都绑定来源系统、时间窗与证据引用；过期数据不会伪装成当前事实。</p></div></section>
        </aside>
      </div>
    </div>
  );
}
