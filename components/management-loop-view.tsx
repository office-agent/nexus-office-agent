"use client";

import {
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Flag,
  GitCommitHorizontal,
  LoaderCircle,
  ListChecks,
  Plus,
  RefreshCw,
  Scale,
  ShieldAlert,
  Sparkles,
  Target,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Risk = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  ownerId: string;
  probability: 1 | 2 | 3 | 4 | 5;
  impact: 1 | 2 | 3 | 4 | 5;
  status: string;
};

type Decision = {
  id: string;
  riskId?: string;
  title: string;
  selectedOption?: string;
  rationale?: string;
  status: string;
};

type ActionItem = {
  id: string;
  version: number;
  decisionId?: string;
  title: string;
  dueAt: string;
  acceptanceCriteria: string;
  status: string;
  completionEvidence?: string;
};

type Snapshot = {
  objective: {
    title: string;
    description: string;
    baseline?: number;
    currentValue?: number;
    targetValue?: number;
    unit?: string;
    endsAt: string;
  };
  project: {
    id: string;
    code: string;
    name: string;
    description: string;
    health: string;
    targetEndAt: string;
    priority: string;
  };
  risks: Risk[];
  decisions: Decision[];
  actionItems: ActionItem[];
  milestones: Array<{
    id: string;
    name: string;
    dueAt: string;
    status: string;
    acceptanceCriteria: string;
  }>;
  tasks: Array<{
    id: string;
    version: number;
    milestoneId?: string;
    title: string;
    description: string;
    status: "todo" | "in_progress" | "blocked" | "in_review" | "completed" | "cancelled";
    priority: string;
    dueAt?: string;
  }>;
  issues: Array<{ id: string; title: string; severity: string; status: string }>;
  generatedAt: string;
};

function defaultDueAt() {
  const due = new Date();
  due.setDate(due.getDate() + 1);
  due.setHours(11, 0, 0, 0);
  const local = new Date(due.getTime() - due.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "操作未完成，请稍后重试。");
  return payload.data as T;
}

function normalizeSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    milestones: snapshot.milestones || [],
    tasks: snapshot.tasks || [],
    issues: snapshot.issues || [],
    risks: snapshot.risks || [],
    decisions: snapshot.decisions || [],
    actionItems: snapshot.actionItems || [],
  };
}

function exposure(risk: Risk) {
  return risk.probability * risk.impact;
}

function exposureLabel(value: number) {
  if (value >= 20) return "极高";
  if (value >= 12) return "高";
  if (value >= 6) return "中";
  return "低";
}

function healthCopy(health: string) {
  return {
    critical: "严重偏离",
    at_risk: "存在风险",
    watch: "需要观察",
    healthy: "健康",
    unknown: "待评估",
  }[health] || health;
}

function nextTaskStatus(status: Snapshot["tasks"][number]["status"]) {
  if (status === "todo") return "in_progress" as const;
  if (status === "in_progress") return "in_review" as const;
  if (status === "blocked") return "in_progress" as const;
  if (status === "in_review") return "completed" as const;
  return null;
}

function taskActionCopy(status: Snapshot["tasks"][number]["status"]) {
  if (status === "todo") return "开始";
  if (status === "in_progress") return "送审";
  if (status === "blocked") return "解除阻塞";
  if (status === "in_review") return "验收完成";
  return null;
}

export function ManagementLoopView({ projectId, actorId, onNotice }: { projectId: string; actorId: string; onNotice: (text: string) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [selectedRiskId, setSelectedRiskId] = useState("");
  const [riskFormOpen, setRiskFormOpen] = useState(false);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [riskForm, setRiskForm] = useState({
    title: "",
    description: "",
    probability: 3,
    impact: 3,
  });
  const [decisionForm, setDecisionForm] = useState({
    selectedOption: "",
    rationale: "",
    actionTitle: "",
    acceptanceCriteria: "",
    dueAt: defaultDueAt(),
  });

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSnapshot(normalizeSnapshot(await apiRequest<Snapshot>(`/api/v1/management/snapshot?projectId=${encodeURIComponent(projectId)}`)));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "管理闭环加载失败。");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSnapshot(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSnapshot]);

  useEffect(() => {
    const refresh = () => void loadSnapshot();
    window.addEventListener("nexus:management-changed", refresh);
    return () => window.removeEventListener("nexus:management-changed", refresh);
  }, [loadSnapshot]);

  const openRisks = useMemo(
    () => snapshot?.risks.filter(({ status }) => status !== "closed") || [],
    [snapshot],
  );
  const pendingActions = useMemo(
    () => snapshot?.actionItems.filter(({ status }) => status !== "completed" && status !== "cancelled") || [],
    [snapshot],
  );
  const selectedRisk = openRisks.find(({ id }) => id === selectedRiskId) || null;
  const decidedRiskIds = new Set(snapshot?.decisions.map(({ riskId }) => riskId).filter(Boolean));
  const highestExposure = Math.max(0, ...openRisks.map(exposure));
  const objectiveProgress = snapshot?.objective.baseline !== undefined && snapshot.objective.currentValue !== undefined && snapshot.objective.targetValue !== undefined
    ? Math.round(
        ((snapshot.objective.currentValue - snapshot.objective.baseline) /
          (snapshot.objective.targetValue - snapshot.objective.baseline)) *
          100,
      )
    : 0;

  async function submitRisk(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) return;
    setBusy("risk");
    setError("");
    try {
      const risk = await apiRequest<Risk>("/api/v1/management/risks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.project.id,
          ownerId: actorId,
          ...riskForm,
          sourceType: "human",
        }),
      });
      setRiskForm({ title: "", description: "", probability: 3, impact: 3 });
      setRiskFormOpen(false);
      setSelectedRiskId(risk.id);
      await loadSnapshot();
      onNotice("风险已登记，事件已写入管理脉络");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "风险登记失败。");
    } finally {
      setBusy("");
    }
  }

  async function submitDecision(event: FormEvent) {
    event.preventDefault();
    if (!snapshot || !selectedRisk) return;
    setBusy("decision");
    setError("");
    try {
      await apiRequest("/api/v1/management/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.project.id,
          riskId: selectedRisk.id,
          title: `处置：${selectedRisk.title}`,
          decisionContext: selectedRisk.description,
          options: [decisionForm.selectedOption],
          selectedOption: decisionForm.selectedOption,
          rationale: decisionForm.rationale,
          actionItems: [
            {
              title: decisionForm.actionTitle,
              ownerId: actorId,
              dueAt: new Date(decisionForm.dueAt).toISOString(),
              acceptanceCriteria: decisionForm.acceptanceCriteria,
            },
          ],
        }),
      });
      setSelectedRiskId("");
      await loadSnapshot();
      onNotice("决策与行动项已生成，责任和验收标准已绑定");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "决策提交失败。");
    } finally {
      setBusy("");
    }
  }

  async function completeAction(id: string, version: number) {
    const completionEvidence = evidence[id]?.trim();
    if (!completionEvidence) {
      setError("完成行动项前必须填写可核验的结果证据。");
      return;
    }
    setBusy(id);
    setError("");
    try {
      await apiRequest(`/api/v1/management/action-items/${id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version, evidence: completionEvidence }),
      });
      await loadSnapshot();
      onNotice("行动项已完成，证据已进入闭环记录");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "行动项更新失败。");
    } finally {
      setBusy("");
    }
  }

  async function advanceTask(task: Snapshot["tasks"][number]) {
    const nextStatus = nextTaskStatus(task.status);
    if (!nextStatus) return;
    setBusy(task.id);
    setError("");
    try {
      await apiRequest(`/api/v1/management/tasks/${task.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: task.version, status: nextStatus }),
      });
      await loadSnapshot();
      onNotice(nextStatus === "completed" ? "任务已完成并写入领域事件" : "任务状态已推进");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "任务状态更新失败。");
    } finally {
      setBusy("");
    }
  }

  if (loading && !snapshot) {
    return <div className="mgmt-state"><LoaderCircle className="mgmt-spin" size={20} /><strong>正在组装管理脉络</strong><span>连接目标、项目、风险与行动证据…</span></div>;
  }

  if (!snapshot) {
    return <div className="mgmt-state mgmt-state-error"><CircleAlert size={20} /><strong>管理闭环暂时不可用</strong><span>{error}</span><button onClick={() => void loadSnapshot()}><RefreshCw size={14} />重新加载</button></div>;
  }

  return (
    <div className="mgmt-view">
      <header className="mgmt-command-head">
        <div className="mgmt-title-block">
          <div className="mgmt-project-mark"><Flag size={20} /></div>
          <div>
            <p><span>{snapshot.project.code}</span> · 交付指挥舱</p>
            <h1>{snapshot.project.name}</h1>
            <small>{snapshot.project.description}</small>
          </div>
        </div>
        <div className="mgmt-head-actions">
          <span className={`mgmt-health mgmt-health-${snapshot.project.health}`}><i />{healthCopy(snapshot.project.health)}</span>
          <button className="mgmt-secondary" onClick={() => void loadSnapshot()} disabled={loading}><RefreshCw className={loading ? "mgmt-spin" : ""} size={14} />刷新</button>
          <button className="mgmt-primary" onClick={() => setRiskFormOpen((current) => !current)}><Plus size={14} />登记风险</button>
        </div>
      </header>

      {error ? <div className="mgmt-error" role="alert"><CircleAlert size={14} /><span>{error}</span><button onClick={() => setError("")}>关闭</button></div> : null}

      <section className="mgmt-objective-strip">
        <div className="mgmt-objective-copy">
          <span><Target size={13} />关联公司目标</span>
          <strong>{snapshot.objective.title}</strong>
          <small>{snapshot.objective.description}</small>
        </div>
        <div className="mgmt-objective-progress">
          <div><span>当前 {snapshot.objective.currentValue}{snapshot.objective.unit}</span><b>目标 {snapshot.objective.targetValue}{snapshot.objective.unit}</b></div>
          <div className="mgmt-progress-track"><span style={{ width: `${Math.max(0, Math.min(100, objectiveProgress))}%` }} /></div>
          <small>目标推进 {objectiveProgress}% · 截止 {snapshot.objective.endsAt}</small>
        </div>
      </section>

      <div className="mgmt-pulse-row">
        <div><span>最高风险暴露</span><strong>{highestExposure}<small>/ 25</small></strong><b className={highestExposure >= 12 ? "is-alert" : ""}>{exposureLabel(highestExposure)}</b></div>
        <div><span>未闭环风险</span><strong>{openRisks.length}<small> 项</small></strong><b>{snapshot.decisions.length} 项已决策</b></div>
        <div><span>待完成行动</span><strong>{pendingActions.length}<small> 项</small></strong><b>{snapshot.actionItems.length - pendingActions.length} 项有证据</b></div>
        <div><span>项目承诺日期</span><strong className="is-date">{snapshot.project.targetEndAt.slice(5).replace("-", ".")}</strong><b>优先级 {snapshot.project.priority}</b></div>
      </div>

      <section className="mgmt-delivery-board">
        <div className="mgmt-delivery-head">
          <div><span><ListChecks size={13} />当前交付包</span><h2>{snapshot.milestones[0]?.name || "待建立里程碑"}</h2><p>{snapshot.milestones[0]?.acceptanceCriteria}</p></div>
          {snapshot.milestones[0] ? <b className={`mgmt-milestone-status is-${snapshot.milestones[0].status}`}>{snapshot.milestones[0].status.replace("_", " ")} · {snapshot.milestones[0].dueAt.slice(5).replace("-", ".")}</b> : null}
        </div>
        <div className="mgmt-task-grid">
          {snapshot.tasks.map((task) => {
            const actionCopy = taskActionCopy(task.status);
            return (
              <article className={`mgmt-task-card is-${task.status}`} key={task.id}>
                <div className="mgmt-task-top"><span>{task.priority}</span><b>{task.status.replace("_", " ")}</b></div>
                <h3>{task.title}</h3><p>{task.description}</p>
                <div className="mgmt-task-foot"><small>{task.dueAt ? `截止 ${new Date(task.dueAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "无截止时间"}</small>{actionCopy ? <button disabled={busy === task.id} onClick={() => void advanceTask(task)}>{busy === task.id ? <LoaderCircle className="mgmt-spin" size={12} /> : task.status === "in_review" ? <Check size={12} /> : <ArrowRight size={12} />}{actionCopy}</button> : <span><CheckCircle2 size={12} />已完成</span>}</div>
              </article>
            );
          })}
        </div>
      </section>

      {riskFormOpen ? (
        <form className="mgmt-risk-form" onSubmit={submitRisk}>
          <div className="mgmt-form-intro"><ShieldAlert size={18} /><div><strong>登记新风险信号</strong><small>先记录事实与影响，决策将在下一步形成。</small></div></div>
          <label><span>风险标题</span><input required minLength={3} value={riskForm.title} onChange={(event) => setRiskForm({ ...riskForm, title: event.target.value })} placeholder="例如：客户验收资源尚未确认" /></label>
          <label className="mgmt-wide-field"><span>事实描述</span><input required minLength={3} value={riskForm.description} onChange={(event) => setRiskForm({ ...riskForm, description: event.target.value })} placeholder="描述已发生的信号、影响范围和时间窗口" /></label>
          <label><span>发生概率 · {riskForm.probability}</span><input type="range" min="1" max="5" value={riskForm.probability} onChange={(event) => setRiskForm({ ...riskForm, probability: Number(event.target.value) })} /></label>
          <label><span>影响程度 · {riskForm.impact}</span><input type="range" min="1" max="5" value={riskForm.impact} onChange={(event) => setRiskForm({ ...riskForm, impact: Number(event.target.value) })} /></label>
          <div className="mgmt-form-actions"><button type="button" onClick={() => setRiskFormOpen(false)}>取消</button><button className="mgmt-primary" disabled={busy === "risk"}>{busy === "risk" ? <LoaderCircle className="mgmt-spin" size={14} /> : <ArrowRight size={14} />}写入脉络</button></div>
        </form>
      ) : null}

      <div className="mgmt-workbench">
        <section className="mgmt-thread-panel">
          <div className="mgmt-section-head"><div><p>MANAGEMENT THREAD</p><h2>从风险到结果的管理脉络</h2></div><span>{openRisks.length + snapshot.decisions.length + snapshot.actionItems.length + 1} 个业务节点</span></div>
          <div className="mgmt-thread">
            <article className="mgmt-thread-node mgmt-node-objective">
              <div className="mgmt-node-rail"><span><Target size={15} /></span><i /></div>
              <div className="mgmt-node-body"><div className="mgmt-node-meta"><span>01 · 目标牵引</span><b>ACTIVE</b></div><h3>{snapshot.objective.title}</h3><p>当前项目直接贡献该经营目标，任何交付偏差都会进入目标复盘。</p></div>
            </article>

            {openRisks.map((risk, index) => {
              const score = exposure(risk);
              const hasDecision = decidedRiskIds.has(risk.id);
              return (
                <article className={`mgmt-thread-node mgmt-node-risk ${score >= 12 ? "is-high" : ""}`} key={risk.id}>
                  <div className="mgmt-node-rail"><span><ShieldAlert size={15} /></span><i /></div>
                  <div className="mgmt-node-body">
                    <div className="mgmt-node-meta"><span>{String(index + 2).padStart(2, "0")} · 风险识别</span><b>暴露度 {score} · {exposureLabel(score)}</b></div>
                    <h3>{risk.title}</h3><p>{risk.description}</p>
                    <div className="mgmt-risk-factors"><span>概率 {risk.probability}/5</span><i>×</i><span>影响 {risk.impact}/5</span><i>=</i><strong>{score}</strong></div>
                    {hasDecision ? <span className="mgmt-linked"><Check size={12} />已关联决策</span> : <button className="mgmt-node-action" onClick={() => setSelectedRiskId(risk.id)}><Scale size={13} />形成处置决策 <ArrowRight size={13} /></button>}
                  </div>
                </article>
              );
            })}

            {snapshot.decisions.map((decision, index) => (
              <article className="mgmt-thread-node mgmt-node-decision" key={decision.id}>
                <div className="mgmt-node-rail"><span><Scale size={15} /></span><i /></div>
                <div className="mgmt-node-body"><div className="mgmt-node-meta"><span>{String(openRisks.length + index + 2).padStart(2, "0")} · 管理决策</span><b>{decision.status.toUpperCase()}</b></div><h3>{decision.title}</h3><p><strong>选择：</strong>{decision.selectedOption}　<span>{decision.rationale}</span></p></div>
              </article>
            ))}

            {snapshot.actionItems.map((item, index) => (
              <article className={`mgmt-thread-node mgmt-node-action-item ${item.status === "completed" ? "is-complete" : ""}`} key={item.id}>
                <div className="mgmt-node-rail"><span>{item.status === "completed" ? <Check size={15} /> : <ClipboardCheck size={15} />}</span>{index < snapshot.actionItems.length - 1 ? <i /> : null}</div>
                <div className="mgmt-node-body"><div className="mgmt-node-meta"><span>{String(openRisks.length + snapshot.decisions.length + index + 2).padStart(2, "0")} · 行动验证</span><b>{item.status === "completed" ? "有证据" : `截止 ${new Date(item.dueAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}</b></div><h3>{item.title}</h3><p>验收标准：{item.acceptanceCriteria}</p>
                  {item.status === "completed" ? <div className="mgmt-evidence"><CheckCircle2 size={13} /><span>{item.completionEvidence}</span></div> : <div className="mgmt-evidence-entry"><input value={evidence[item.id] || ""} onChange={(event) => setEvidence({ ...evidence, [item.id]: event.target.value })} placeholder="填写文档编号、会议结论或可核验结果" /><button disabled={busy === item.id} onClick={() => void completeAction(item.id, item.version)}>{busy === item.id ? <LoaderCircle className="mgmt-spin" size={13} /> : <Check size={13} />}提交证据</button></div>}
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="mgmt-assistant-panel">
          {selectedRisk ? (
            <form onSubmit={submitDecision} className="mgmt-decision-form">
              <div className="mgmt-assistant-kicker"><Scale size={15} /><span>决策工作区</span><button type="button" onClick={() => setSelectedRiskId("")}>关闭</button></div>
              <h3>{selectedRisk.title}</h3><p>{selectedRisk.description}</p>
              <label><span>选择处置方案</span><input required minLength={2} value={decisionForm.selectedOption} onChange={(event) => setDecisionForm({ ...decisionForm, selectedOption: event.target.value })} placeholder="填写经责任人确认的处置方案" /></label>
              <label><span>决策理由</span><textarea required minLength={3} rows={3} value={decisionForm.rationale} onChange={(event) => setDecisionForm({ ...decisionForm, rationale: event.target.value })} /></label>
              <div className="mgmt-action-draft"><div><GitCommitHorizontal size={14} /><strong>随决策下达行动</strong></div><label><span>行动项</span><input required value={decisionForm.actionTitle} onChange={(event) => setDecisionForm({ ...decisionForm, actionTitle: event.target.value })} /></label><label><span>验收标准</span><textarea required rows={2} value={decisionForm.acceptanceCriteria} onChange={(event) => setDecisionForm({ ...decisionForm, acceptanceCriteria: event.target.value })} /></label><label><span>完成时限</span><input required type="datetime-local" value={decisionForm.dueAt} onChange={(event) => setDecisionForm({ ...decisionForm, dueAt: event.target.value })} /></label></div>
              <button className="mgmt-primary mgmt-submit-decision" disabled={busy === "decision"}>{busy === "decision" ? <LoaderCircle className="mgmt-spin" size={14} /> : <Scale size={14} />}确认决策并下达行动</button>
            </form>
          ) : (
            <>
              <div className="mgmt-assistant-kicker"><Sparkles size={15} /><span>Agent 管理观察</span><b>可解释</b></div>
              <div className="mgmt-agent-signal"><span><Bot size={17} /></span><div><small>当前优先判断</small><strong>{highestExposure >= 12 ? "交付窗口仍可保住，但需要立即缩小风险敞口。" : "项目处于可控区间，继续验证关键行动证据。"}</strong></div></div>
              <p className="mgmt-agent-reason">判断依据：最高风险暴露度为 {highestExposure}/25，当前有 {openRisks.length} 项未闭环风险、{pendingActions.length} 项行动等待结果证据。</p>
              <div className="mgmt-assistant-divider" />
              <h4>建议的管理动作</h4>
              <ol><li><span>1</span><p><strong>先定边界</strong>为高暴露风险选择处置方案，明确哪些范围不做。</p></li><li><span>2</span><p><strong>再定责任</strong>每项决策必须带责任人、时限和验收标准。</p></li><li><span>3</span><p><strong>最后验真</strong>行动完成不等于闭环，需提交可追溯结果证据。</p></li></ol>
              {!openRisks.some((risk) => !decidedRiskIds.has(risk.id)) ? <div className="mgmt-all-decided"><CheckCircle2 size={16} /><span><strong>风险均已进入决策</strong><small>继续跟踪行动证据即可。</small></span></div> : <button className="mgmt-assistant-cta" onClick={() => setSelectedRiskId(openRisks.find((risk) => !decidedRiskIds.has(risk.id))?.id || "")}><Scale size={14} />处理下一项未决风险 <ArrowRight size={13} /></button>}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
