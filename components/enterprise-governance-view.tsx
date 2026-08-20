"use client";

import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileClock,
  GitPullRequestArrow,
  History,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  UserRoundCog,
  UsersRound,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Project = { id: string; code: string; name: string; status: string; targetEndAt: string; baselineVersion: number; projectVersion: number; businessValue: string; acceptanceCriteria: string };
type Objective = { id: string; title: string; status: string; ownerId: string; baseline: number; targetValue: number; currentValue: number; unit: string };
type OrganizationChange = { id: string; subjectUserId: string; changeType: "transfer" | "departure"; effectiveAt: string; successorUserId?: string; reason: string; status: string; requestedBy: string; approvedBy?: string; version: number };
type Handoff = { id: string; resourceType: string; resourceId: string; fromUserId: string; toUserId: string; status: string; evidenceRef: string };
type ProjectChange = { id: string; projectId: string; changeType: string; proposedBaseline: Record<string, unknown>; reason: string; impactAssessment: string; requestedBy: string; approvedBy?: string; status: string; version: number };
type ClosureReview = { id: string; projectId: string; deliveryAcceptanceRef: string; unresolvedItems: unknown[]; retrospectiveRef: string; ownerId: string; status: string; approvedBy?: string; version: number };
type AttentionItem = { id: string; projectId: string; sourceType: string; sourceId: string; reasonCode: string; severity: "watch" | "at_risk" | "critical"; ownerId: string; details: Record<string, unknown>; status: string; detectedAt: string; version: number };
type CompensationPlan = { id: string; resourceId: string; sourceOperationId: string; expectedResourceVersion: number; status: string; expiresAt: string; version: number };
type Workspace = { objectives: Objective[]; projects: Project[]; organizationChanges: OrganizationChange[]; handoffs: Handoff[]; projectChanges: ProjectChange[]; closureReviews: ClosureReview[]; attentionItems: AttentionItem[]; compensationPlans: CompensationPlan[]; generatedAt: string };

const statusLabel: Record<string, string> = { submitted: "待审批", approved: "已批准", completed: "已完成", applied: "已应用", compensated: "已补偿", ready: "待确认", open: "待处理", transferred: "已移交" };
const attentionLabel: Record<string, string> = { milestone_overdue: "里程碑逾期", milestone_at_risk: "里程碑有风险", critical_task_blocked: "关键任务阻塞", risk_exposure: "风险暴露超阈值", action_overdue: "行动项逾期", budget_variance: "预算超支" };
const resourceLabel: Record<string, string> = { project: "项目", task: "任务", risk: "风险", objective: "目标", issue: "问题", action_item: "行动项", approval: "审批", responsibility: "责任" };

function dateOffset(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export function EnterpriseGovernanceView({ actorId, selectedProjectId, onNotice }: { actorId: string | null; selectedProjectId: string | null; onNotice: (message: string) => void }) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [activeLane, setActiveLane] = useState<"attention" | "organization" | "baseline" | "closure">("attention");
  const [subjectUserId, setSubjectUserId] = useState("");
  const [successorUserId, setSuccessorUserId] = useState("");
  const [orgReason, setOrgReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(() => dateOffset(1));
  const [targetEndAt, setTargetEndAt] = useState(() => dateOffset(60));
  const [baselineFormMode, setBaselineFormMode] = useState<"initiative" | "change">("initiative");
  const [initiativeCode, setInitiativeCode] = useState("");
  const [initiativeName, setInitiativeName] = useState("");
  const [initiativeStartAt, setInitiativeStartAt] = useState(() => dateOffset(0));
  const [objectiveTitle, setObjectiveTitle] = useState("");
  const [objectiveBaseline, setObjectiveBaseline] = useState("");
  const [objectiveCurrent, setObjectiveCurrent] = useState("");
  const [objectiveTarget, setObjectiveTarget] = useState("");
  const [objectiveUnit, setObjectiveUnit] = useState("");
  const [businessValue, setBusinessValue] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [impactAssessment, setImpactAssessment] = useState("");
  const [acceptanceRef, setAcceptanceRef] = useState("");
  const [retrospectiveRef, setRetrospectiveRef] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/enterprise-governance/workspace", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "企业治理工作区加载失败");
      setWorkspace(payload.data);
    } catch (error) { onNotice(error instanceof Error ? error.message : "企业治理工作区加载失败"); }
    finally { setLoading(false); }
  }, [onNotice]);

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/enterprise-governance/workspace", { cache: "no-store" })
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error?.message || "企业治理工作区加载失败");
        if (active) setWorkspace(payload.data);
      })
      .catch((error) => { if (active) onNotice(error instanceof Error ? error.message : "企业治理工作区加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function mutate(key: string, path: string, method: "POST" | "PUT", body: unknown, success: string) {
    setBusy(key);
    try {
      const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "治理操作失败");
      await load();
      onNotice(success);
    } catch (error) { onNotice(error instanceof Error ? error.message : "治理操作失败"); }
    finally { setBusy(""); }
  }

  const project = workspace?.projects.find((item) => item.id === selectedProjectId) ?? workspace?.projects[0];
  const personName = (id?: string) => id === actorId ? "当前用户" : id ? `成员 ${id.slice(0, 8)}` : "待指定";
  const openAttention = workspace?.attentionItems.filter((item) => item.status === "open") ?? [];
  const pendingChanges = (workspace?.organizationChanges.filter((item) => item.status === "submitted" || item.status === "approved").length ?? 0)
    + (workspace?.projectChanges.filter((item) => item.status === "submitted" || item.status === "approved").length ?? 0);
  const criticalCount = openAttention.filter((item) => item.severity === "critical").length;
  const handoffCount = workspace?.handoffs.filter((item) => item.status === "transferred").length ?? 0;
  const governanceClock = Date.parse(workspace?.generatedAt ?? "1970-01-01T00:00:00.000Z");
  const laneCounts = useMemo(() => ({
    attention: openAttention.length,
    organization: workspace?.organizationChanges.length ?? 0,
    baseline: workspace?.projectChanges.length ?? 0,
    closure: (workspace?.closureReviews.length ?? 0) + (workspace?.compensationPlans.length ?? 0),
  }), [openAttention.length, workspace]);

  if (loading && !workspace) return <div className="governance-control-state"><LoaderCircle className="spin"/><strong>正在重建企业治理视图</strong><span>核对组织、项目基线、异常与审计链路</span></div>;

  function createDeparture(event: FormEvent) {
    event.preventDefault();
    void mutate("org-create", "/api/v1/enterprise-governance/organization-changes", "POST", {
      subjectUserId, changeType: "departure", effectiveAt: `${effectiveDate}T00:00:00.000Z`, successorUserId, reason: orgReason,
    }, "离职交接单已提交；发起人与审批人必须分离");
  }

  function createBaselineChange(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    void mutate("baseline-create", "/api/v1/enterprise-governance/project-changes", "POST", {
      projectId: project.id, changeType: "schedule", proposedBaseline: { targetEndAt }, reason: changeReason, impactAssessment,
    }, "项目基线变更已提交；当前正式基线尚未改变");
  }

  function createInitiative(event: FormEvent) {
    event.preventDefault();
    if (!actorId) return;
    void mutate("initiative-create", "/api/v1/enterprise-governance/initiatives", "POST", {
      objective: { title: objectiveTitle, description: businessValue, ownerId: actorId, baseline: Number(objectiveBaseline), targetValue: Number(objectiveTarget), currentValue: Number(objectiveCurrent), unit: objectiveUnit, startsAt: initiativeStartAt, endsAt: targetEndAt, reviewCadence: "monthly" },
      project: { code: initiativeCode, name: initiativeName, description: businessValue, ownerId: actorId, businessValue, acceptanceCriteria, resourcePlan: {}, priority: "high", startsAt: initiativeStartAt, targetEndAt },
    }, "目标与项目已原子提交立项，正式执行仍需后续审批");
  }

  return <div className="governance-control-view">
    <header className="governance-control-hero">
      <div><p className="eyebrow">ENTERPRISE CONTROL PLANE</p><h1>权限、变更与经营控制</h1><p>把组织异动、项目基线、管理例外和结项验收放进同一条可审批、可补偿、可审计的管理闭环。</p></div>
      <button onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""}/>刷新治理状态</button>
    </header>

    <section className="governance-control-ribbon">
      <div className={criticalCount ? "is-critical" : "is-good"}><AlertTriangle size={19}/><span><strong>{criticalCount}</strong><small>关键管理例外</small></span></div>
      <div><GitPullRequestArrow size={19}/><span><strong>{pendingChanges}</strong><small>待处理变更</small></span></div>
      <div><UsersRound size={19}/><span><strong>{handoffCount}</strong><small>已形成交接证据</small></span></div>
      <div className="is-good"><ShieldCheck size={19}/><span><strong>实时</strong><small>授权重算与原子审计</small></span></div>
    </section>

    <nav className="governance-lanes" aria-label="治理工作流">
      {([
        ["attention", "管理关注", ScanSearch], ["organization", "组织异动", UserRoundCog], ["baseline", "项目基线", BriefcaseBusiness], ["closure", "结项与补偿", ClipboardCheck],
      ] as const).map(([id, label, Icon]) => <button key={id} className={activeLane === id ? "active" : ""} onClick={() => setActiveLane(id)}><Icon size={15}/><span>{label}</span><b>{laneCounts[id]}</b></button>)}
    </nav>

    {activeLane === "attention" ? <section className="governance-control-grid">
      <article className="governance-control-card governance-attention-main">
        <header><span><ScanSearch size={17}/><div><strong>管理关注队列</strong><small>里程碑、阻塞、风险、逾期行动与预算偏差自动归集</small></div></span><button className="governance-primary" disabled={Boolean(busy)} onClick={() => void mutate("scan", "/api/v1/enterprise-governance/attention/scan", "POST", {}, "已重新扫描管理例外，相同异常不会重复建单")}><ScanSearch size={13}/>{busy === "scan" ? "扫描中…" : "立即扫描"}</button></header>
        <div className="attention-list">{openAttention.length ? openAttention.map((item) => <div className={`attention-row severity-${item.severity}`} key={item.id}><span className="attention-severity"><i/>{item.severity === "critical" ? "关键" : item.severity === "at_risk" ? "风险" : "观察"}</span><div><strong>{attentionLabel[item.reasonCode] ?? item.reasonCode}</strong><small>{resourceLabel[item.sourceType] ?? item.sourceType} · {String(item.details.exposure ?? item.details.dueAt ?? item.details.actualCost ?? "已越过治理阈值")}</small></div><span className="attention-owner">负责人：{personName(item.ownerId)}</span><b>v{item.version}</b></div>) : <div className="governance-empty"><BadgeCheck size={24}/><strong>当前没有打开的管理例外</strong><span>运行扫描后，系统只建立需要管理者介入的事项。</span></div>}</div>
      </article>
      <aside className="governance-principles"><p className="eyebrow">AI MANAGEMENT LOOP</p><h2>AI 只升级例外，不替代责任人</h2><ol><li><span>01</span><div><strong>事实检测</strong><small>从正式业务对象计算阈值，不靠聊天印象。</small></div></li><li><span>02</span><div><strong>责任定位</strong><small>每个例外绑定项目、来源和负责人。</small></div></li><li><span>03</span><div><strong>人工处置</strong><small>高风险动作仍需审批或明确确认。</small></div></li></ol></aside>
    </section> : null}

    {activeLane === "organization" ? <section className="governance-control-grid">
      <article className="governance-control-card">
        <header><span><UserRoundCog size={17}/><div><strong>组织异动控制</strong><small>先交接责任，再撤权、撤设备、撤外部身份</small></div></span><span className="control-badge"><ShieldCheck size={12}/>职责分离</span></header>
        <div className="change-ledger">{workspace?.organizationChanges.map((item) => <div className="change-record" key={item.id}><div className="change-icon"><UserRoundCog size={16}/></div><div><span className="record-meta">{item.changeType === "departure" ? "离职" : "转岗"} · {new Date(item.effectiveAt).toLocaleDateString("zh-CN")}</span><strong>{personName(item.subjectUserId)} → {personName(item.successorUserId)}</strong><small>{item.reason}</small></div><span className={`record-status is-${item.status}`}>{statusLabel[item.status] ?? item.status}</span><div className="record-actions">{item.status === "submitted" ? <button disabled={Boolean(busy)} onClick={() => void mutate(`org-approve-${item.id}`, `/api/v1/enterprise-governance/organization-changes/${item.id}/approve`, "POST", { version: item.version }, "组织异动已由独立审批人批准")}><CheckCircle2 size={12}/>批准</button> : null}{item.status === "approved" ? <button disabled={Boolean(busy) || Date.parse(item.effectiveAt) > governanceClock} onClick={() => void mutate(`org-execute-${item.id}`, `/api/v1/enterprise-governance/organization-changes/${item.id}/execute`, "POST", { version: item.version }, "组织异动已执行，责任与权限同步更新")}><ArrowRight size={12}/>{Date.parse(item.effectiveAt) > governanceClock ? "等待生效" : "执行交接"}</button> : null}</div></div>)}</div>
        {workspace?.handoffs.length ? <div className="handoff-evidence"><p>最近交接证据</p>{workspace.handoffs.slice(0, 5).map((item) => <span key={item.id}><CheckCircle2 size={12}/><b>{resourceLabel[item.resourceType] ?? item.resourceType}</b><small>{item.evidenceRef}</small></span>)}</div> : null}
      </article>
      <form className="governance-control-card governance-form" onSubmit={createDeparture}><header><span><FileClock size={17}/><div><strong>新建离职交接单</strong><small>对象和继任人必须使用企业身份 ID</small></div></span></header><label><span>变更对象 ID</span><input value={subjectUserId} onChange={(event) => setSubjectUserId(event.target.value)} placeholder="企业用户 UUID" required/></label><label><span>继任人 ID</span><input value={successorUserId} onChange={(event) => setSuccessorUserId(event.target.value)} placeholder="企业用户 UUID" required/></label><label><span>生效日期</span><input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} required/></label><label><span>变更原因与交接范围</span><textarea rows={4} value={orgReason} onChange={(event) => setOrgReason(event.target.value)} minLength={3} maxLength={1000} required/></label><div className="form-assurance"><ShieldCheck size={14}/><span>存在未关闭责任时，未指定继任人将拒绝执行。</span></div><button className="governance-primary" disabled={Boolean(busy)}>{busy === "org-create" ? "提交中…" : "提交独立审批"}<ArrowRight size={13}/></button></form>
    </section> : null}

    {activeLane === "baseline" ? <section className="governance-control-grid">
      <article className="governance-control-card">
        <header><span><BriefcaseBusiness size={17}/><div><strong>{project?.name ?? "项目基线"}</strong><small>正式基线 v{project?.baselineVersion ?? "-"} · 对象版本 v{project?.projectVersion ?? "-"}</small></div></span><span className="control-badge">{project?.status ?? "unknown"}</span></header>
        <div className="baseline-facts"><div><small>业务价值</small><strong>{project?.businessValue}</strong></div><div><small>验收标准</small><strong>{project?.acceptanceCriteria}</strong></div><div><small>目标结束</small><strong>{project?.targetEndAt}</strong></div></div>
        <div className="change-ledger">{workspace?.projectChanges.map((item) => <div className="change-record" key={item.id}><div className="change-icon"><GitPullRequestArrow size={16}/></div><div><span className="record-meta">{item.changeType.toUpperCase()} · {String(item.proposedBaseline.targetEndAt ?? "基线字段变更")}</span><strong>{item.reason}</strong><small>{item.impactAssessment}</small></div><span className={`record-status is-${item.status}`}>{statusLabel[item.status] ?? item.status}</span><div className="record-actions">{item.status === "submitted" ? <button disabled={Boolean(busy)} onClick={() => void mutate(`project-approve-${item.id}`, `/api/v1/enterprise-governance/project-changes/${item.id}/approve`, "POST", { version: item.version }, "基线变更已由独立审批人批准")}><CheckCircle2 size={12}/>批准</button> : null}{item.status === "approved" ? <button disabled={Boolean(busy)} onClick={() => void mutate(`project-apply-${item.id}`, `/api/v1/enterprise-governance/project-changes/${item.id}/apply`, "POST", { version: item.version }, "新基线已原子应用，同时生成七天补偿计划")}><ArrowRight size={12}/>应用基线</button> : null}</div></div>)}</div>
      </article>
      <form className="governance-control-card governance-form" onSubmit={baselineFormMode === "initiative" ? createInitiative : createBaselineChange}><header><span><CalendarClock size={17}/><div><strong>{baselineFormMode === "initiative" ? "目标驱动立项" : "提出进度基线变更"}</strong><small>{baselineFormMode === "initiative" ? "目标、价值、资源和验收一次关联" : "提交不会直接修改正式项目"}</small></div></span></header><div className="governance-form-switch"><button type="button" className={baselineFormMode === "initiative" ? "active" : ""} onClick={() => setBaselineFormMode("initiative")}>新建立项</button><button type="button" className={baselineFormMode === "change" ? "active" : ""} onClick={() => setBaselineFormMode("change")}>变更基线</button></div>{baselineFormMode === "initiative" ? <><label><span>目标</span><input value={objectiveTitle} onChange={(event) => setObjectiveTitle(event.target.value)} minLength={3} maxLength={160} required/></label><div className="governance-form-pair"><label><span>基线值</span><input type="number" value={objectiveBaseline} onChange={(event) => setObjectiveBaseline(event.target.value)} required/></label><label><span>当前值</span><input type="number" value={objectiveCurrent} onChange={(event) => setObjectiveCurrent(event.target.value)} required/></label></div><div className="governance-form-pair"><label><span>目标值</span><input type="number" value={objectiveTarget} onChange={(event) => setObjectiveTarget(event.target.value)} required/></label><label><span>计量单位</span><input value={objectiveUnit} onChange={(event) => setObjectiveUnit(event.target.value)} placeholder="例如：%、天、万元" required/></label></div><div className="governance-form-pair"><label><span>项目编码</span><input value={initiativeCode} onChange={(event) => setInitiativeCode(event.target.value.toUpperCase())} pattern="[A-Za-z0-9][A-Za-z0-9._-]+" required/></label><label><span>项目名称</span><input value={initiativeName} onChange={(event) => setInitiativeName(event.target.value)} required/></label></div><label><span>业务价值</span><textarea rows={2} value={businessValue} onChange={(event) => setBusinessValue(event.target.value)} required/></label><label><span>验收标准</span><textarea rows={2} value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} required/></label><div className="governance-form-pair"><label><span>开始日期</span><input type="date" value={initiativeStartAt} onChange={(event) => setInitiativeStartAt(event.target.value)} required/></label><label><span>目标结束</span><input type="date" value={targetEndAt} onChange={(event) => setTargetEndAt(event.target.value)} required/></label></div></> : <><label><span>新目标结束日期</span><input type="date" value={targetEndAt} onChange={(event) => setTargetEndAt(event.target.value)} required/></label><label><span>变更原因</span><input value={changeReason} onChange={(event) => setChangeReason(event.target.value)} minLength={3} maxLength={2000} required/></label><label><span>影响评估</span><textarea rows={4} value={impactAssessment} onChange={(event) => setImpactAssessment(event.target.value)} minLength={3} maxLength={3000} required/></label></>}<button className="governance-primary" disabled={Boolean(busy) || (baselineFormMode === "initiative" && !actorId)}>{busy === "initiative-create" || busy === "baseline-create" ? "提交中…" : baselineFormMode === "initiative" ? "提交立项" : "提交基线审批"}<ArrowRight size={13}/></button></form>
    </section> : null}

    {activeLane === "closure" ? <section className="governance-control-grid">
      <article className="governance-control-card">
        <header><span><ClipboardCheck size={17}/><div><strong>结项 Gate 与补偿事务</strong><small>验收、遗留移交、复盘缺一不可；已应用变更可受控逆转</small></div></span><span className="control-badge"><ShieldCheck size={12}/>数据库强制</span></header>
        <div className="closure-gate"><div className={workspace?.closureReviews.length ? "done" : "pending"}><span>1</span><div><strong>验收与复盘证据</strong><small>{workspace?.closureReviews.length ? "已形成结项评审" : "等待项目责任人提交"}</small></div></div><i/><div className={project?.status === "closing" || project?.status === "completed" ? "done" : "pending"}><span>2</span><div><strong>进入 closing</strong><small>当前项目状态：{project?.status}</small></div></div><i/><div className={project?.status === "completed" ? "done" : "pending"}><span>3</span><div><strong>独立审批后完成</strong><small>同一事务写项目、评审与审计</small></div></div></div>
        {workspace?.closureReviews.map((review) => <div className="closure-review" key={review.id}><div><span className="record-meta">{statusLabel[review.status] ?? review.status} · v{review.version}</span><strong>{review.deliveryAcceptanceRef}</strong><small>{review.retrospectiveRef} · 遗留移交 {review.unresolvedItems.length} 项</small></div>{review.status === "ready" && project ? <button disabled={Boolean(busy) || project.status !== "closing"} onClick={() => void mutate(`closure-${review.id}`, `/api/v1/enterprise-governance/project-closures/${review.projectId}/complete`, "POST", { closureVersion: review.version, projectVersion: project.projectVersion }, "项目已通过结项 Gate，验收与审计证据完整")}><CheckCircle2 size={12}/>{project.status === "closing" ? "审批并结项" : "等待 closing"}</button> : null}</div>)}
        <div className="compensation-list">{workspace?.compensationPlans.map((plan) => <div key={plan.id}><RotateCcw size={15}/><span><strong>基线补偿计划</strong><small>绑定项目版本 v{plan.expectedResourceVersion} · {new Date(plan.expiresAt).toLocaleDateString("zh-CN")} 到期</small></span><b>{statusLabel[plan.status] ?? plan.status}</b>{plan.status === "ready" ? <button disabled={Boolean(busy)} onClick={() => void mutate(`compensation-${plan.id}`, `/api/v1/enterprise-governance/compensations/${plan.id}/execute`, "POST", { version: plan.version }, "补偿事务已执行，项目恢复到变更前业务基线")}><RotateCcw size={12}/>执行补偿</button> : null}</div>)}</div>
      </article>
      <form className="governance-control-card governance-form" onSubmit={(event) => { event.preventDefault(); if (project) void mutate("closure-save", `/api/v1/enterprise-governance/project-closures/${project.id}`, "PUT", { deliveryAcceptanceRef: acceptanceRef, unresolvedItems: [], retrospectiveRef }, "结项评审已保存；仍需独立审批且项目必须进入 closing"); }}><header><span><History size={17}/><div><strong>准备结项评审</strong><small>证据引用不可为空</small></div></span></header><label><span>交付验收依据</span><input value={acceptanceRef} onChange={(event) => setAcceptanceRef(event.target.value)} required/></label><label><span>复盘知识引用</span><input value={retrospectiveRef} onChange={(event) => setRetrospectiveRef(event.target.value)} required/></label><div className="form-assurance"><ShieldCheck size={14}/><span>未关闭事项必须逐项指定接手人和移交证据。</span></div><button className="governance-primary" disabled={Boolean(busy) || !project}>{busy === "closure-save" ? "保存中…" : "保存结项评审"}<ArrowRight size={13}/></button></form>
    </section> : null}
  </div>;
}
