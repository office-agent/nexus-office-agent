"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, BookOpenText, Bot, CheckCircle2, Clock3, FileCheck2, GitBranch, LockKeyhole, MessageSquareText, Search, ShieldCheck, Users } from "lucide-react";

type Approval = { id: string; instanceId: string; dueAt: string; version: number; status: string };
type Instance = { id: string; definitionId: string; title: string; definitionVersion: number; status: string; riskLevel: number; formSnapshot: Record<string, unknown>; version: number };
type Definition = { id: string; name: string; currentVersion: number; status: string };
type Meeting = {
  id: string; title: string; status: string; outcomeStatus: string; version: number;
  confirmedByIds: string[]; requiredConfirmerIds: string[];
  draftMinutes: { discussions: string[]; conclusions: string[]; decisions: Array<{ topic: string; selectedOption: string; rationale: string; actionItems: Array<{ title: string; dueAt: string }> }>; openQuestions: string[] };
};
type DocumentHead = { id: string; title: string; classification: string; currentVersion: number; status: string };
type Citation = { id: string; title: string; excerpt: string; locator: string; documentVersion: number; classification: string; untrustedContent: true };
type Workspace = { workflow: { definitions: Definition[]; instances: Instance[]; pendingApprovals: Approval[] }; meetings: Meeting[]; documents: DocumentHead[] };
type AssistantResult = { recommendation?: string; findings?: string[]; agenda?: string[]; evidenceGaps?: string[]; citations: Citation[]; stateChanged: false };

const classificationLabel: Record<string, string> = { public: "公开", internal: "内部", confidential: "机密", restricted: "受限" };

export function GovernanceCenterView({ onNotice, focus }: { onNotice: (message: string) => void; focus: "approvals" | "knowledge" }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [assistant, setAssistant] = useState<AssistantResult | null>(null);
  const [query, setQuery] = useState("数据安全");
  const [citations, setCitations] = useState<Citation[]>([]);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/governance/workspace", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "治理工作台加载失败");
      setWorkspace(payload.data);
    } catch (error) { onNotice(error instanceof Error ? error.message : "治理工作台加载失败"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/governance/workspace", { cache: "no-store" })
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error?.message || "治理工作台加载失败");
        if (active) setWorkspace(payload.data);
      })
      .catch((error) => { if (active) onNotice(error instanceof Error ? error.message : "治理工作台加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = workspace?.workflow.pendingApprovals[0];
  const instance = workspace?.workflow.instances.find(({ id }) => id === pending?.instanceId) ?? workspace?.workflow.instances[0];
  const definition = workspace?.workflow.definitions.find(({ id }) => id === instance?.definitionId) ?? workspace?.workflow.definitions[0];
  const meeting = workspace?.meetings[0];

  async function postAction(key: string, url: string, body: unknown, success: string) {
    setWorking(key);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "操作失败");
      onNotice(success);
      await load();
      return payload.data;
    } catch (error) { onNotice(error instanceof Error ? error.message : "操作失败"); }
    finally { setWorking(""); }
  }

  async function runPreReview() {
    if (!instance) return;
    setWorking("review");
    try {
      const response = await fetch(`/api/v1/workflows/process-instances/${instance.id}/pre-review`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "预审失败");
      setAssistant(payload.data);
      onNotice("Agent 只生成了预审意见，审批状态没有改变");
    } catch (error) { onNotice(error instanceof Error ? error.message : "预审失败"); }
    finally { setWorking(""); }
  }

  async function prepareMeeting() {
    if (!meeting) return;
    setWorking("meeting-prepare");
    try {
      const response = await fetch(`/api/v1/meetings/${meeting.id}/prepare`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "会议准备失败");
      setAssistant(payload.data);
      onNotice("会议准备包已生成，没有修改正式纪要");
    } catch (error) { onNotice(error instanceof Error ? error.message : "会议准备失败"); }
    finally { setWorking(""); }
  }

  async function searchKnowledge(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setWorking("search");
    try {
      const response = await fetch(`/api/v1/knowledge/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "检索失败");
      setCitations(payload.data);
      if (!payload.data.length) onNotice("当前权限和有效版本内没有找到结果");
    } catch (error) { onNotice(error instanceof Error ? error.message : "检索失败"); }
    finally { setWorking(""); }
  }

  return (
    <div className={`governance-view governance-focus-${focus}`}>
      <header className="governance-hero">
        <div><p className="eyebrow">HUMAN GOVERNANCE LOOP</p><h1>{focus === "approvals" ? "流程、审批与会议" : "企业知识与依据"}</h1><p>AI 负责准备材料和指出缺口；正式审批、会议纪要与企业知识都由明确的人、版本和权限边界控制。</p></div>
        <span className="governance-safety"><ShieldCheck size={15} /> 运行中流程锁定定义版本</span>
      </header>

      <section className="governance-metrics" aria-busy={loading}>
        <div><FileCheck2 size={17} /><span><strong>{workspace?.workflow.pendingApprovals.length ?? "—"}</strong><small>待我审批</small></span></div>
        <div><GitBranch size={17} /><span><strong>{workspace?.workflow.instances.filter(({ status }) => status === "running").length ?? "—"}</strong><small>运行中流程</small></span></div>
        <div><MessageSquareText size={17} /><span><strong>{workspace?.meetings.filter(({ status }) => status === "pending_confirmation").length ?? "—"}</strong><small>待确认纪要</small></span></div>
        <div><BookOpenText size={17} /><span><strong>{workspace?.documents.length ?? "—"}</strong><small>权限内知识</small></span></div>
      </section>

      <div className="governance-columns">
        <div className="governance-main">
          <section className="governance-card approval-workbench">
            <div className="governance-card-head"><div><span className="card-icon"><FileCheck2 size={16} /></span><div><h2>审批工作台</h2><p>权限来自岗位与策略，不来自按钮是否可见</p></div></div>{instance && <span className={`risk-badge risk-${instance.riskLevel}`}>R{instance.riskLevel} · 人工决定</span>}</div>
            {instance ? <>
              <div className="approval-title"><div><strong>{instance.title}</strong><span>{definition?.name ?? "版本化流程"} · 实例锁定 v{instance.definitionVersion} / 当前发布 v{definition?.currentVersion ?? instance.definitionVersion}</span></div><span className="status-pill">{instance.status === "running" ? "审批中" : instance.status === "approved" ? "已通过" : instance.status}</span></div>
              <div className="form-facts">{Object.entries(instance.formSnapshot).slice(0, 5).map(([key, value]) => <div key={key}><span>{key}</span><strong>{typeof value === "number" ? value.toLocaleString("zh-CN") : String(value)}</strong></div>)}</div>
              <div className="version-pin"><LockKeyhole size={14} /><span>本实例始终按启动时的 v{instance.definitionVersion} 执行；后续发布的新规则只影响新实例。</span></div>
              <div className="workbench-actions"><button onClick={() => void runPreReview()} disabled={working === "review"}><Bot size={14} />{working === "review" ? "分析中…" : "Agent 预审"}</button>{pending ? <button className="decision-button" disabled={Boolean(working)} onClick={() => void postAction("approve", `/api/v1/workflows/approvals/${pending.id}/decide`, { decision: "approve", comment: "已核对事实与职责分离", version: pending.version }, "审批已由当前责任人确认并写入审计链")}>人工通过 <ArrowRight size={13} /></button> : <span className="completed-note"><CheckCircle2 size={14} />当前审批已处理</span>}</div>
            </> : <div className="governance-empty">暂无审批实例</div>}
          </section>

          {assistant && <section className="assistant-review-card"><div><span><Bot size={15} /></span><div><strong>Agent 准备结果</strong><small>{assistant.stateChanged === false ? "只读分析 · 未改变业务状态" : ""}</small></div></div>{assistant.recommendation && <p className="recommendation">建议：{assistant.recommendation === "request_more_information" ? "补充材料后再决定" : "转人工复核"}</p>}<ul>{[...(assistant.findings ?? []), ...(assistant.evidenceGaps ?? []), ...(assistant.agenda ?? [])].map((item) => <li key={item}>{item}</li>)}</ul>{assistant.citations.length > 0 && <div className="assistant-sources">{assistant.citations.map((citation) => <span key={citation.id}><ShieldCheck size={11} />{citation.title} · v{citation.documentVersion}</span>)}</div>}</section>}

          <section className="governance-card meeting-workbench">
            <div className="governance-card-head"><div><span className="card-icon"><Users size={16} /></span><div><h2>会议确认闭环</h2><p>讨论不是决定，AI 纪要确认后才能沉淀</p></div></div>{meeting && <span className="status-pill">{meeting.status === "pending_confirmation" ? "待参会人确认" : "已确认"}</span>}</div>
            {meeting ? <div className="meeting-body"><div className="meeting-meta"><strong>{meeting.title}</strong><span><Clock3 size={12} />需 {meeting.requiredConfirmerIds.length} 人确认 · 已确认 {meeting.confirmedByIds.length}</span></div><div className="minutes-grid"><div><span>讨论</span><p>{meeting.draftMinutes.discussions[0]}</p></div><div><span>结论</span><p>{meeting.draftMinutes.conclusions[0]}</p></div><div><span>决定</span><p>{meeting.draftMinutes.decisions[0]?.topic}：{meeting.draftMinutes.decisions[0]?.selectedOption}</p></div><div><span>行动</span><p>{meeting.draftMinutes.decisions[0]?.actionItems[0]?.title}</p></div></div><div className="workbench-actions"><button onClick={() => void prepareMeeting()} disabled={Boolean(working)}><Bot size={14} />准备会议依据</button>{meeting.status !== "confirmed" ? <button className="decision-button" disabled={Boolean(working)} onClick={() => void postAction("meeting-confirm", `/api/v1/meetings/${meeting.id}/confirm`, { version: meeting.version }, "纪要已确认，决定与行动项已幂等写回项目")}>确认纪要并沉淀 <ArrowRight size={13} /></button> : <span className="completed-note"><CheckCircle2 size={14} />决定与行动已沉淀</span>}</div></div> : <div className="governance-empty">暂无待确认会议</div>}
          </section>
        </div>

        <aside className="knowledge-rail">
          <section className="governance-card knowledge-search-card">
            <div className="governance-card-head"><div><span className="card-icon"><BookOpenText size={16} /></span><div><h2>权限感知检索</h2><p>检索前过滤，返回前再次校验</p></div></div></div>
            <form onSubmit={searchKnowledge}><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索制度、案例或决定" /><button disabled={working === "search"}>检索</button></form>
            <div className="document-stack">{workspace?.documents.map((document) => <div key={document.id}><span className={`classification class-${document.classification}`}>{classificationLabel[document.classification]}</span><div><strong>{document.title}</strong><small>当前有效版本 v{document.currentVersion}</small></div></div>)}</div>
            {citations.length > 0 && <div className="citation-results">{citations.map((citation) => <article key={citation.id}><div><span>[{citation.locator}]</span><b>{citation.title} · v{citation.documentVersion}</b></div><p>{citation.excerpt}</p><small><ShieldCheck size={11} />已通过权限、有效版本与二次过滤 · 外部文字按不可信数据处理</small></article>)}</div>}
          </section>
          <div className="knowledge-policy-note"><LockKeyhole size={16} /><div><strong>不会进入通用 RAG</strong><p>受限文档、未经授权的 1:1 记录、过期或被替代版本默认不进入 Agent 检索。</p></div></div>
        </aside>
      </div>
    </div>
  );
}
