"use client";

import {
  Archive,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  ClipboardCheck,
  CodeXml,
  FileArchive,
  FileDiff,
  FileText,
  GitCommitHorizontal,
  LoaderCircle,
  LockKeyhole,
  PackageCheck,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TestTubeDiagonal,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

type ProjectStatus = "requirements_archived" | "in_development" | "testing" | "ready_to_deliver" | "delivered";
type DocumentRecord = { id: string; kind: string; path: string; revision: number; content: string; digest: string; archivedAt: string };
type VersionRecord = { id: string; projectId: string; name: string; fromCommit: string; toCommit: string; diffDigest: string; diffExcerpt: string; diffSize: number; features: string[]; createdAt: string };
type TestRecord = { id: string; projectId: string; versionId: string; name: string; cases: string[]; result: "passed" | "failed"; evidence: string; evidenceDigest: string; createdAt: string };
type DeliveryRecord = { id: string; manifestDigest: string; documentDigests: Record<string, string>; versionIds: string[]; testIds: string[]; createdAt: string };
type DevelopmentProject = {
  id: string; code: string; name: string; owner: string; objective: string; scope: string[]; nonGoals: string[]; acceptanceCriteria: string[];
  status: ProjectStatus; version: number; updatedAt: string; documents: DocumentRecord[]; versions: VersionRecord[]; tests: TestRecord[]; delivery?: DeliveryRecord;
};
type SkillRecommendation = { name: string; stage: "handoff" | "development" | "testing" | "delivery" | "throughout"; purpose: string; required: boolean };
type Snapshot = { projects: DevelopmentProject[]; skills: SkillRecommendation[]; generatedAt: string };
type Panel = "handoff" | "version" | "test" | null;
type DetailTab = "progress" | "archive" | "evidence" | "skills";

const statusCopy: Record<ProjectStatus, string> = {
  requirements_archived: "需求已归档",
  in_development: "开发中",
  testing: "功能测试中",
  ready_to_deliver: "可交付",
  delivered: "已交付",
};
const documentCopy: Record<string, string> = { overview: "项目总览", progress: "项目进度", features: "功能文档", versions: "版本记录", acceptance: "功能验收" };
const skillStageCopy = { handoff: "需求交接", development: "开发过程", testing: "功能测试", delivery: "交付", throughout: "全程" };

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}
function shortDigest(value: string) { return `${value.slice(0, 10)}…${value.slice(-6)}`; }
function idempotencyKey(prefix: string) { return `${prefix}:${crypto.randomUUID()}`; }
function projectTestGate(project: DevelopmentProject) {
  return project.versions.length > 0 && project.versions.every((version) => project.tests.some((test) => test.versionId === version.id && test.result === "passed"));
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "请求未完成");
  return payload.data as T;
}

export function AgentDevelopmentWorkflow({ onNotice }: { onNotice: (message: string) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [tab, setTab] = useState<DetailTab>("progress");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const data = await api<Snapshot>("/api/v1/agent-development/projects", { cache: "no-store" });
      setSnapshot(data);
      setSelectedId((current) => current && data.projects.some(({ id }) => id === current) ? current : data.projects[0]?.id ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Agent 开发工作流加载失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { const initial = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(initial); }, [load]);
  const projects = snapshot?.projects ?? [];
  const selected = projects.find(({ id }) => id === selectedId) ?? null;
  const readyCount = projects.filter(({ status }) => status === "ready_to_deliver").length;
  const deliveredCount = projects.filter(({ status }) => status === "delivered").length;

  const updateProject = useCallback((project: DevelopmentProject) => {
    setSnapshot((current) => current ? { ...current, projects: current.projects.some(({ id }) => id === project.id) ? current.projects.map((item) => item.id === project.id ? project : item) : [project, ...current.projects] } : current);
    setSelectedId(project.id);
  }, []);

  async function submitHandoff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const project = await api<DevelopmentProject>("/api/v1/agent-development/projects", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey("development-handoff") }, body: JSON.stringify({ code: form.get("code"), name: form.get("name"), owner: form.get("owner"), objective: form.get("objective"), scope: lines(form.get("scope")), nonGoals: lines(form.get("nonGoals")), acceptanceCriteria: lines(form.get("acceptance")) }) });
      updateProject(project); setPanel(null); setTab("archive"); onNotice("需求已转化为五类 project-to-act 文档并完成平台留档");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "需求交接失败"); }
    finally { setSubmitting(false); }
  }

  async function submitVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const project = await api<DevelopmentProject>(`/api/v1/agent-development/projects/${selected.id}/versions`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey("development-version") }, body: JSON.stringify({ projectVersion: selected.version, name: form.get("name"), fromCommit: form.get("fromCommit"), toCommit: form.get("toCommit"), diffContent: form.get("diffContent"), features: lines(form.get("features")) }) });
      updateProject(project); setPanel(null); setTab("evidence"); onNotice("主要版本的 Diff、功能清单和文档修订已留档");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "版本留档失败"); }
    finally { setSubmitting(false); }
  }

  async function submitTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const project = await api<DevelopmentProject>(`/api/v1/agent-development/projects/${selected.id}/tests`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey("development-test") }, body: JSON.stringify({ projectVersion: selected.version, versionId: form.get("versionId"), name: form.get("name"), cases: lines(form.get("cases")), result: form.get("result"), evidence: form.get("evidence") }) });
      updateProject(project); setPanel(null); setTab("evidence"); onNotice(project.status === "ready_to_deliver" ? "全部主要版本已有通过的功能测试，可以进入交付" : "功能测试证据已留档");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "测试留档失败"); }
    finally { setSubmitting(false); }
  }

  async function deliver() {
    if (!selected) return; setSubmitting(true);
    try {
      const project = await api<DevelopmentProject>(`/api/v1/agent-development/projects/${selected.id}/delivery`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey("development-delivery") }, body: JSON.stringify({ projectVersion: selected.version }) });
      updateProject(project); setTab("archive"); onNotice("交付清单已冻结：五文档、主要版本与功能测试均已包含");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "交付清单生成失败"); }
    finally { setSubmitting(false); }
  }

  if (loading) return <div className="development-state"><LoaderCircle className="spin" size={24} /><strong>正在读取研发事实源</strong><span>核对需求、版本、测试和交付门禁…</span></div>;
  if (error) return <div className="development-state is-error"><LockKeyhole size={24} /><strong>Agent 开发工作流不可用</strong><span>{error}</span><button onClick={() => void load()}><RefreshCw size={13} />重新加载</button></div>;

  return <div className="development-workflow">
    <header className="development-hero">
      <div><p className="eyebrow">AGENT DEVELOPMENT · TEAM LEDGER</p><h1>Agent 开发</h1><p>用同一条证据链统一技术团队的需求交接、主要版本、功能测试和最终交付。</p></div>
      <button className="development-primary" onClick={() => setPanel("handoff")}><Plus size={15} />新建需求交接</button>
    </header>

    <section className="development-facts" aria-label="研发工作概览">
      <div><Archive size={17} /><span><strong>{projects.length}</strong><small>已归档项目</small></span></div>
      <div><CodeXml size={17} /><span><strong>{projects.reduce((sum, item) => sum + item.versions.length, 0)}</strong><small>主要版本</small></span></div>
      <div><ClipboardCheck size={17} /><span><strong>{readyCount}</strong><small>等待交付</small></span></div>
      <div><PackageCheck size={17} /><span><strong>{deliveredCount}</strong><small>已冻结交付</small></span></div>
    </section>

    {projects.length === 0 ? <section className="development-empty">
      <span><FileArchive size={24} /></span><p className="eyebrow">FIRST GATE</p><h2>先归档，再开发</h2><p>新需求会自动转化为项目总览、进度、功能、版本和验收五份文档。只有平台确认留档完整后，才会开放版本登记。</p><button className="development-primary" onClick={() => setPanel("handoff")}>开始需求交接<ArrowRight size={14} /></button>
    </section> : <div className="development-layout">
      <aside className="development-project-list">
        <header><span>研发项目</span><b>{projects.length}</b></header>
        {projects.map((project) => <button key={project.id} className={project.id === selectedId ? "active" : ""} onClick={() => { setSelectedId(project.id); setTab("progress"); }}>
          <span className="development-project-code">{project.code}</span><strong>{project.name}</strong><small>{project.owner} · {project.versions.length} 个主要版本</small><i className={`is-${project.status}`}>{statusCopy[project.status]}</i><ChevronRight size={13} />
        </button>)}
      </aside>

      {selected ? <main className="development-dossier">
        <section className="development-project-head">
          <div><span>{selected.code}</span><h2>{selected.name}</h2><p>{selected.objective}</p></div>
          <div><small>当前负责人</small><strong>{selected.owner}</strong><i className={`is-${selected.status}`}>{statusCopy[selected.status]}</i></div>
        </section>

        <GateRail project={selected} />

        <nav className="development-tabs" aria-label="项目研发事实">
          {(["progress", "archive", "evidence", "skills"] as DetailTab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item === "progress" ? "工作进度" : item === "archive" ? "项目文档" : item === "evidence" ? "版本与测试" : "Skill 建议"}</button>)}
        </nav>

        {tab === "progress" ? <ProgressView project={selected} /> : tab === "archive" ? <ArchiveView project={selected} /> : tab === "evidence" ? <EvidenceView project={selected} /> : <SkillsView project={selected} skills={snapshot?.skills ?? []} />}

        <footer className="development-actions">
          <div><ShieldCheck size={14} /><span>门禁由服务端重验；页面状态不能绕过留档条件。</span></div>
          {selected.status !== "delivered" ? <>
            <button onClick={() => setPanel("version")}><GitCommitHorizontal size={14} />登记主要版本</button>
            <button disabled={!selected.versions.length} onClick={() => setPanel("test")}><TestTubeDiagonal size={14} />登记功能测试</button>
            <button className="is-delivery" disabled={!projectTestGate(selected) || submitting} onClick={() => void deliver()}><PackageCheck size={14} />{submitting ? "正在冻结…" : "生成交付清单"}</button>
          </> : <span className="development-delivered"><CheckCircle2 size={15} />交付清单 {shortDigest(selected.delivery!.manifestDigest)}</span>}
        </footer>
      </main> : null}
    </div>}

    {panel ? createPortal(<div className="development-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) setPanel(null); }}>
      <section className="development-dialog" role="dialog" aria-modal="true" aria-labelledby="development-dialog-title">
        <header><div><p className="eyebrow">{panel === "handoff" ? "GATE 01" : panel === "version" ? "GATE 02" : "GATE 03"}</p><h2 id="development-dialog-title">{panel === "handoff" ? "需求交接与自动归档" : panel === "version" ? "主要版本留档" : "功能测试留档"}</h2></div><button aria-label="关闭" disabled={submitting} onClick={() => setPanel(null)}><X size={17} /></button></header>
        {panel === "handoff" ? <HandoffForm busy={submitting} onSubmit={submitHandoff} /> : panel === "version" ? <VersionForm busy={submitting} onSubmit={submitVersion} /> : selected ? <TestForm project={selected} busy={submitting} onSubmit={submitTest} /> : null}
      </section>
    </div>, document.body) : null}
  </div>;
}

function GateRail({ project }: { project: DevelopmentProject }) {
  const testGate = projectTestGate(project);
  const steps = [
    { label: "需求归档", detail: `${project.documents.length}/5 文档`, done: project.documents.length === 5, active: project.status === "requirements_archived" },
    { label: "主要版本", detail: `${project.versions.length} 个 Diff`, done: project.versions.length > 0, active: project.status === "in_development" },
    { label: "功能测试", detail: testGate ? "逐版本通过" : "仍有缺口", done: testGate, active: project.status === "testing" || project.status === "ready_to_deliver" },
    { label: "交付冻结", detail: project.delivery ? "清单已生成" : "等待门禁", done: Boolean(project.delivery), active: project.status === "ready_to_deliver" },
  ];
  return <section className="development-gate-rail">{steps.map((step, index) => <div key={step.label} className={`${step.done ? "done" : ""} ${step.active ? "active" : ""}`}><span>{step.done ? <Check size={12} /> : step.active ? <CircleDashed size={12} /> : <LockKeyhole size={11} />}</span><div><small>0{index + 1}</small><strong>{step.label}</strong><p>{step.detail}</p></div>{index < steps.length - 1 ? <i /> : null}</div>)}</section>;
}

function ProgressView({ project }: { project: DevelopmentProject }) {
  const passingVersions = project.versions.filter((version) => project.tests.some((test) => test.versionId === version.id && test.result === "passed")).length;
  const blockers = project.documents.length !== 5 ? ["需求文档归档不完整"] : !project.versions.length ? ["尚未登记主要版本"] : project.versions.filter((version) => !project.tests.some((test) => test.versionId === version.id && test.result === "passed")).map((version) => `${version.name} 缺少通过的功能测试`);
  return <div className="development-tab-grid">
    <section className="development-card"><header><span><FileText size={15} /><strong>需求基线</strong></span><small>由交接信息自动转换</small></header><div className="development-baseline"><div><small>范围</small>{project.scope.map((item) => <p key={item}>{item}</p>)}</div><div><small>验收</small>{project.acceptanceCriteria.map((item) => <p key={item}>{item}</p>)}</div></div></section>
    <section className="development-card development-blockers"><header><span><LockKeyhole size={15} /><strong>当前门禁</strong></span><small>{blockers.length ? `${blockers.length} 个待补项` : "无缺项"}</small></header>{blockers.length ? blockers.map((item) => <p key={item}><CircleDashed size={13} />{item}</p>) : <div className="development-pass"><CheckCircle2 size={21} /><strong>{project.delivery ? "交付事实已冻结" : "已满足交付前置"}</strong><span>{project.delivery ? "后续变更需要新建主要版本。" : "可以生成最终交付清单。"}</span></div>}</section>
    <section className="development-card development-version-progress"><header><span><GitCommitHorizontal size={15} /><strong>版本测试覆盖</strong></span><small>{passingVersions}/{project.versions.length || 0} 版本通过</small></header>{project.versions.length ? project.versions.map((version) => { const passed = project.tests.some((test) => test.versionId === version.id && test.result === "passed"); return <div key={version.id}><span>{version.name}</span><i><b style={{ width: passed ? "100%" : project.tests.some((test) => test.versionId === version.id) ? "52%" : "18%" }} /></i><small>{passed ? "通过" : "待测试"}</small></div>; }) : <p className="development-quiet">需求已归档，等待首个主要版本。</p>}</section>
  </div>;
}

function ArchiveView({ project }: { project: DevelopmentProject }) {
  return <div className="development-archive-list">{project.documents.map((document) => <details key={document.id}><summary><span><FileText size={15} /><i>{documentCopy[document.kind] ?? document.kind}</i></span><span><code>R{document.revision}</code><code>{shortDigest(document.digest)}</code><ChevronRight size={13} /></span></summary><div><p>{document.path}</p><pre>{document.content}</pre><small>归档于 {new Date(document.archivedAt).toLocaleString("zh-CN")} · SHA-256 {document.digest}</small></div></details>)}{project.delivery ? <section className="development-manifest"><PackageCheck size={18} /><div><small>DELIVERY MANIFEST</small><strong>{project.delivery.manifestDigest}</strong><p>包含 {project.delivery.versionIds.length} 个主要版本、{project.delivery.testIds.length} 条通过测试和 5 份最新项目文档。</p></div></section> : null}</div>;
}

function EvidenceView({ project }: { project: DevelopmentProject }) {
  return <div className="development-evidence-list">{project.versions.length ? project.versions.map((version) => { const tests = project.tests.filter((test) => test.versionId === version.id); return <article key={version.id}><header><span><FileDiff size={16} /><div><strong>{version.name}</strong><small>{version.fromCommit.slice(0, 8)} → {version.toCommit.slice(0, 8)}</small></div></span><code>{shortDigest(version.diffDigest)}</code></header><div className="development-feature-list">{version.features.map((feature) => <span key={feature}><Check size={11} />{feature}</span>)}</div><details><summary>查看 Diff 留档摘要 · {version.diffSize.toLocaleString()} 字符</summary><pre>{version.diffExcerpt}</pre></details><section>{tests.length ? tests.map((test) => <div key={test.id} className={`development-test-record is-${test.result}`}><span>{test.result === "passed" ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />}<strong>{test.name}</strong></span><small>{test.cases.length} 项用例 · {shortDigest(test.evidenceDigest)}</small><p>{test.evidence}</p></div>) : <div className="development-test-record is-missing"><span><LockKeyhole size={14} /><strong>缺少功能测试</strong></span><small>该版本尚不能进入交付清单</small></div>}</section></article>; }) : <div className="development-evidence-empty"><FileDiff size={22} /><strong>还没有主要版本</strong><span>登记版本时必须同时提交 Diff 和功能清单。</span></div>}</div>;
}

function SkillsView({ project, skills }: { project: DevelopmentProject; skills: SkillRecommendation[] }) {
  const currentStage = project.status === "requirements_archived" ? "development" : project.status === "in_development" || project.status === "testing" ? "testing" : project.status === "ready_to_deliver" ? "delivery" : "throughout";
  return <div className="development-skills"><section><Sparkles size={18} /><div><small>当前建议</small><h3>{project.status === "requirements_archived" ? "用受控协作推进首个版本" : project.status === "in_development" || project.status === "testing" ? "围绕逐版本功能测试补齐证据" : project.status === "ready_to_deliver" ? "按交付门禁复核全部材料" : "把后续改动重新纳入版本治理"}</h3><p>Skill 只提供工作方法，不会扩大平台权限或替代留档门禁。</p></div></section>{skills.map((skill) => <article key={skill.name} className={skill.stage === currentStage || skill.stage === "throughout" ? "recommended" : ""}><div><code>${skill.name}</code>{skill.required ? <b>必需</b> : null}</div><span>{skillStageCopy[skill.stage]}</span><p>{skill.purpose}</p></article>)}</div>;
}

function HandoffForm({ busy, onSubmit }: { busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="development-form" onSubmit={onSubmit}><div className="development-form-pair"><label><span>项目编码</span><input name="code" required placeholder="AGENT-OPS" /></label><label><span>项目名称</span><input name="name" required placeholder="研发效能 Agent" /></label></div><label><span>交付负责人</span><input name="owner" required placeholder="姓名或技术小组" /></label><label><span>项目目标</span><textarea name="objective" required rows={3} placeholder="这个项目最终要解决什么问题？" /></label><label><span>工作范围 · 每行一项</span><textarea name="scope" required rows={4} placeholder={"统一需求入口\n实现研发进度追踪"} /></label><label><span>非目标 · 每行一项</span><textarea name="nonGoals" rows={3} placeholder="本阶段明确不做什么" /></label><label><span>功能验收标准 · 每行一项</span><textarea name="acceptance" required rows={4} placeholder={"需求必须完成五文档归档\n每个主要版本具备功能测试"} /></label><div className="development-form-assurance"><Archive size={14} /><span>提交后，平台会原子生成并归档五类 project-to-act 文档；归档失败不会开放下一步。</span></div><button className="development-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <FileArchive size={14} />}{busy ? "正在转换并归档…" : "转换需求并完成留档"}</button></form>;
}

function VersionForm({ busy, onSubmit }: { busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="development-form" onSubmit={onSubmit}><label><span>主要版本</span><input name="name" required placeholder="0.2.0-agent-workflow" /></label><div className="development-form-pair"><label><span>起始 Commit SHA</span><input name="fromCommit" required minLength={7} placeholder="a1b2c3d" /></label><label><span>结束 Commit SHA</span><input name="toCommit" required minLength={7} placeholder="e4f5a6b" /></label></div><label><span>完整 Diff 内容</span><textarea name="diffContent" required rows={8} spellCheck={false} placeholder="粘贴 git diff；平台保存原文并计算 SHA-256。" /></label><label><span>本版本功能 · 每行一项</span><textarea name="features" required rows={5} placeholder={"需求自动归档\n版本门禁与进度视图"} /></label><div className="development-form-assurance"><FileDiff size={14} /><span>Diff 与功能清单将进入不可省略的版本证据，并同步生成 project-to-act 文档新修订。</span></div><button className="development-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <GitCommitHorizontal size={14} />}{busy ? "正在留档…" : "保存主要版本"}</button></form>;
}

function TestForm({ project, busy, onSubmit }: { project: DevelopmentProject; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="development-form" onSubmit={onSubmit}><label><span>对应主要版本</span><select name="versionId" required>{project.versions.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}</select></label><label><span>功能测试名称</span><input name="name" required placeholder="需求归档与门禁回归" /></label><label><span>功能用例 · 每行一项</span><textarea name="cases" required rows={5} placeholder={"提交需求后生成五份文档\n归档前登记版本返回 409"} /></label><div className="development-form-pair"><label><span>测试结果</span><select name="result" defaultValue="passed"><option value="passed">通过</option><option value="failed">失败</option></select></label><label><span>证据说明</span><input name="evidence" required placeholder="命令、报告路径或复核结论" /></label></div><div className="development-form-assurance"><TestTubeDiagonal size={14} /><span>只有“通过”的功能测试满足交付门禁；失败记录会保留，但不会被包装成完成。</span></div><button className="development-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <ClipboardCheck size={14} />}{busy ? "正在留档…" : "保存测试证据"}</button></form>;
}
