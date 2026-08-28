"use client";

import {
  ArrowRight,
  BarChart3,
  Bot,
  CalendarDays,
  Check,
  CircleAlert,
  CircleDashed,
  FileCheck2,
  FolderKanban,
  ListTodo,
  LoaderCircle,
  MessageCircle,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Citation = { id: string; label: string; excerpt: string; objectType: string };
type PersistedMessage = { id: string; role: "user" | "assistant" | "tool"; content: string; runId?: string; route: { skills: string[]; tools: string[] }; citations: Citation[]; createdAt: string };
type Person = { id: string; displayName: string; orgName?: string; positionName?: string; activeTaskCount: number };
type Task = {
  id: string; missionId: string; title: string; description: string; acceptanceCriteria: string; requiredSkills: string[];
  assignmentMode: "direct" | "open_claim"; assigneeId?: string; targetOrgUnitId?: string; publishedBy: string; priority: "critical" | "high" | "medium" | "low";
  dueAt: string; capacityPoints: number; status: "published" | "assigned" | "claimed" | "in_progress" | "blocked" | "in_review" | "completed" | "cancelled";
  evidenceRefs: string[]; blockedReason?: string; isTemplate: boolean; missingFields: string[]; version: number;
};
type PoolFeedback = { id: string; messageId: string; content: string; authorId: string; createdAt: string };
type PoolMessage = { id: string; poolKey: string; subject: string; content: string; authorId: string; createdAt: string; feedback: PoolFeedback[] };
type MessagePool = { key: string; name: string; scope: "company" | "department"; orgUnitId?: string; messages: PoolMessage[] };
type TaskHandoff = {
  id: string; packageId: string; fromAssigneeId: string; toAssigneeId: string; note: string; artifactRefs: string[]; status: "pending" | "accepted" | "rejected";
  responseNote?: string; createdAt: string; respondedAt?: string;
  snapshot: { packageVersion: number; title: string; description: string; acceptanceCriteria: string; evidenceRefs: string[]; dueAt: string };
};
type Workspace = {
  conversation: { id: string; title: string };
  messages: PersistedMessage[];
  people: Person[];
  orgUnits: Array<{ id: string; name: string }>;
  myTasks: Task[];
  availableTasks: Task[];
  publishedByMe: Task[];
  templates: Task[];
  handoffs: TaskHandoff[];
  pendingHandoffs: Array<{ handoff: TaskHandoff; task: Task }>;
  messagePools: MessagePool[];
  generatedAt: string;
};
type DisplayMessage = {
  role: "assistant" | "user";
  content: string;
  runId?: string;
  citations?: Citation[];
  routing?: { skills: string[]; tools: string[] };
  proposal?: { id: string; proposalHash: string; preview: string; riskLevel: number; expiresAt: string; status: string };
  job?: { id: string; status: "queued" | "executing" | "retry_scheduled" | "succeeded" | "failed" | "unknown" | "dead_letter" | "cancelled" | "compensated"; errorCode?: string; unknownReason?: string };
};

const statusCopy: Record<Task["status"], string> = {
  published: "待承接", assigned: "已分派", claimed: "已承接", in_progress: "进行中", blocked: "阻塞", in_review: "待验收", completed: "已完成", cancelled: "已取消",
};
const priorityCopy = { critical: "紧急", high: "高", medium: "中", low: "低" } as const;
const officeShortcuts = [
  { label: "任务", icon: ListTodo, prompt: "帮我处理一项任务。先理解目标、时限、相关人员和已有交接链，再决定是直接回答、拆分、分派、承接还是正式交接。" },
  { label: "消息", icon: MessageCircle, prompt: "我需要发一条沟通消息。请先判断它是否只是同步、征询或反馈；若不产生责任人、截止时间和验收，请放入合适的公司或部门消息池。" },
  { label: "审批", icon: FileCheck2, prompt: "我需要处理一项审批，请先询问必要信息，再根据当前权限和流程继续。" },
  { label: "项目", icon: FolderKanban, prompt: "帮我查看或推进一个项目。请先确认项目和我想完成的事情。" },
  { label: "会议", icon: CalendarDays, prompt: "帮我准备或跟进一场会议，请先确认会议主题、参与人和目标。" },
  { label: "知识", icon: Search, prompt: "帮我从已授权的企业知识中查找信息，并给出可核验引用。" },
  { label: "经营", icon: BarChart3, prompt: "帮我分析一个经营问题，严格区分事实、推断和建议。" },
] as const;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "请求未完成");
  return payload.data as T;
}

export function WorkCommandCenter({
  messages,
  query,
  isThinking,
  confirmingProposal,
  onQueryChange,
  onSubmit,
  onConfirmProposal,
  onHydrate,
  onNotice,
}: {
  messages: DisplayMessage[];
  query: string;
  isThinking: boolean;
  confirmingProposal: string;
  onQueryChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onConfirmProposal: (proposal: NonNullable<DisplayMessage["proposal"]>) => void;
  onHydrate: (conversationId: string, messages: DisplayMessage[]) => void;
  onNotice: (message: string) => void;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [taskMode, setTaskMode] = useState<"mine" | "available" | "published" | "handoffs">("mine");
  const [railMode, setRailMode] = useState<"tasks" | "messages">("tasks");
  const [busyTask, setBusyTask] = useState("");
  const hydrated = useRef(false);
  const conversationEnd = useRef<HTMLDivElement>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      const data = await api<Workspace>("/api/v1/task-command/workspace", { cache: "no-store" });
      setWorkspace(data);
      setError("");
      if (!hydrated.current) {
        hydrated.current = true;
        onHydrate(data.conversation.id, data.messages.filter(({ role }) => role !== "tool").map((item) => ({
          role: item.role as "assistant" | "user", content: item.content, runId: item.runId, citations: item.citations, routing: item.route,
        })));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务工作区加载失败");
    } finally { setLoading(false); }
  }, [onHydrate]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);
  useEffect(() => {
    const stream = new EventSource("/api/v1/task-command/message-events");
    const refresh = () => void loadWorkspace();
    stream.addEventListener("message-change", refresh);
    return () => stream.close();
  }, [loadWorkspace]);
  useEffect(() => {
    const stream = new EventSource("/api/v1/task-command/events");
    const refresh = () => void loadWorkspace();
    stream.addEventListener("task-change", refresh);
    window.addEventListener("nexus:task-command-changed", refresh);
    return () => { stream.close(); window.removeEventListener("nexus:task-command-changed", refresh); };
  }, [loadWorkspace]);
  useEffect(() => { conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, isThinking]);

  const tasks = taskMode === "mine" ? workspace?.myTasks ?? [] : taskMode === "available" ? workspace?.availableTasks ?? [] : taskMode === "published" ? workspace?.publishedByMe ?? [] : workspace?.pendingHandoffs.map(({ task }) => task) ?? [];
  const peopleById = useMemo(() => new Map(workspace?.people.map((person) => [person.id, person]) ?? []), [workspace]);
  const orgUnitsById = useMemo(() => new Map(workspace?.orgUnits.map((unit) => [unit.id, unit]) ?? []), [workspace]);
  const handoffsByPackage = useMemo(() => {
    const values = new Map<string, TaskHandoff[]>();
    for (const handoff of workspace?.handoffs ?? []) values.set(handoff.packageId, [...(values.get(handoff.packageId) ?? []), handoff]);
    return values;
  }, [workspace]);
  const pendingHandoffsByTask = useMemo(() => new Map(workspace?.pendingHandoffs.map(({ task, handoff }) => [task.id, handoff]) ?? []), [workspace]);
  const messageCount = useMemo(() => workspace?.messagePools.reduce((total, pool) => total + pool.messages.length, 0) ?? 0, [workspace]);

  async function claim(task: Task) {
    setBusyTask(task.id);
    try {
      await api(`/api/v1/task-command/packages/${task.id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version }) });
      onNotice(`已承接“${task.title}”`);
      await loadWorkspace();
      setTaskMode("mine");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "承接失败"); }
    finally { setBusyTask(""); }
  }

  async function transition(task: Task, nextStatus: Task["status"]) {
    setBusyTask(task.id);
    try {
      await api(`/api/v1/task-command/packages/${task.id}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version, nextStatus }) });
      onNotice(`任务已进入“${statusCopy[nextStatus]}”`);
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "任务推进失败"); }
    finally { setBusyTask(""); }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return <div className="work-command-center is-unified-office-entry">
    <div className="command-center-grid">
      <section className="primary-conversation-panel">
        <div className="conversation-toolbar">
          <div><span className="command-agent-mark"><Sparkles size={16} /></span><div><strong>枢纽 Agent</strong><small><i /> 企业办公入口</small></div></div>
          <div className="conversation-guard"><span><ShieldCheck size={14} />权限已同步</span><button type="button" onClick={() => onQueryChange("我想处理一件新的办公事项，请先询问必要信息。") }><Plus size={14} />新事项</button></div>
        </div>

        <div className="command-conversation" aria-live="polite">
          {!messages.length ? <div className="command-welcome"><h1>有什么需要处理？</h1><p>直接说就可以。审批、项目、会议、知识、经营分析和任务都可以从这里开始。</p></div> : null}
          {messages.map((message, index) => <article key={`${message.runId ?? "message"}-${index}`} className={`command-message is-${message.role}`}>
            {message.role === "assistant" ? <span className="command-message-avatar"><Bot size={16} /></span> : null}
            <div className="command-message-body">
              {message.role === "assistant" ? <div className="command-message-meta"><span>{message.proposal ? "待确认" : message.job ? "执行状态" : "枢纽"}</span></div> : null}
              <p>{message.content}</p>
              {message.routing?.tools.length ? <details className="route-proof"><summary>已使用 {message.routing.tools.length} 项办公能力</summary><span>{message.routing.tools.join(" · ")}</span></details> : null}
              {message.citations?.length ? <div className="command-citations"><span><ShieldCheck size={12} />核验依据</span>{message.citations.slice(0, 5).map((citation, citationIndex) => <details key={citation.id}><summary><b>[{citationIndex + 1}]</b>{citation.label}</summary><small>{citation.excerpt}</small></details>)}</div> : null}
              {message.proposal ? <div className="command-proposal"><div><span>R{message.proposal.riskLevel} · 人工确认</span><b>{new Date(message.proposal.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 前有效</b></div><strong>{message.proposal.preview}</strong><button disabled={confirmingProposal === message.proposal.id} onClick={() => onConfirmProposal(message.proposal!)}>{confirmingProposal === message.proposal.id ? "正在校验…" : "确认并执行"}<ArrowRight size={13} /></button></div> : null}
              {message.job ? <div className="command-job"><Radio size={13} /><span>{message.job.status}</span><code>{message.job.id.slice(0, 8)}</code></div> : null}
            </div>
          </article>)}
          {isThinking ? <article className="command-message is-assistant"><span className="command-message-avatar"><Bot size={16} /></span><div className="command-thinking"><i /><i /><i /><span>正在处理</span></div></article> : null}
          <div ref={conversationEnd} />
        </div>

        <div className="command-suggestions" aria-label="常用办公入口">{officeShortcuts.map(({ label, prompt, icon: Icon }) => <button type="button" key={label} onClick={() => onQueryChange(prompt)}><Icon size={15} />{label}</button>)}</div>
        <form className="primary-composer" onSubmit={onSubmit}>
          <label htmlFor="primary-work-command">说说你要处理什么</label>
          <textarea id="primary-work-command" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={handleComposerKeyDown} rows={4} placeholder="输入一件要处理的事…" />
          <footer><div><span><ShieldCheck size={13} />只使用当前账号有权访问的数据和能力</span><small>Ctrl / ⌘ + Enter 发送</small></div><button type="submit" aria-label="发送" disabled={!query.trim() || isThinking}>{isThinking ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></footer>
        </form>
      </section>

      <aside className="live-task-rail">
        <header><div><h2>{railMode === "tasks" ? "任务" : "消息池"}</h2><p>{workspace ? `已同步 · ${formatTime(workspace.generatedAt)}` : "正在同步"}</p></div><div className="task-rail-actions"><button className="task-publish-action" type="button" onClick={() => onQueryChange(railMode === "tasks" ? "我需要正式发布一项任务，请先确认目标、接收对象（个人或部门）、截止时间、验收标准和分派方式。" : "我需要推送一条沟通消息。请理解内容后放入当前可见的合适消息池；这不是任务，不需要负责人、截止时间或验收。") }><Plus size={14} />{railMode === "tasks" ? "新建" : "推送"}</button><button type="button" onClick={() => void loadWorkspace()} aria-label="刷新工作区"><RotateCcw className={loading ? "spin" : ""} size={15} /></button></div></header>
        <div className="task-rail-tabs task-rail-mode-tabs" role="tablist" aria-label="工作上下文">
          <button type="button" role="tab" aria-selected={railMode === "tasks"} className={railMode === "tasks" ? "active" : ""} onClick={() => setRailMode("tasks")}><ListTodo size={14} />任务 <b>{(workspace?.myTasks.length ?? 0) + (workspace?.availableTasks.length ?? 0)}</b></button>
          <button type="button" role="tab" aria-selected={railMode === "messages"} className={railMode === "messages" ? "active" : ""} onClick={() => setRailMode("messages")}><MessageCircle size={14} />消息 <b>{messageCount}</b></button>
        </div>
        {railMode === "tasks" ? <>
          <div className="task-rail-tabs task-rail-task-tabs" role="tablist" aria-label="任务范围">
            <button type="button" role="tab" aria-selected={taskMode === "mine"} className={taskMode === "mine" ? "active" : ""} onClick={() => setTaskMode("mine")}><UserRoundCheck size={14} />我的 <b>{workspace?.myTasks.length ?? 0}</b></button>
            <button type="button" role="tab" aria-selected={taskMode === "available"} className={taskMode === "available" ? "active" : ""} onClick={() => setTaskMode("available")}><UsersRound size={14} />可承接 <b>{workspace?.availableTasks.length ?? 0}</b></button>
            <button type="button" role="tab" aria-selected={taskMode === "published"} className={taskMode === "published" ? "active" : ""} onClick={() => setTaskMode("published")}><Radio size={14} />已发布 <b>{workspace?.publishedByMe.length ?? 0}</b></button>
            <button type="button" role="tab" aria-selected={taskMode === "handoffs"} className={taskMode === "handoffs" ? "active" : ""} onClick={() => setTaskMode("handoffs")}><FileCheck2 size={14} />待交接 <b>{workspace?.pendingHandoffs.length ?? 0}</b></button>
          </div>
          <div className="task-rail-list">
          {loading && !workspace ? <TaskRailState icon={LoaderCircle} title="正在同步任务" detail="" spinning /> : error && !workspace ? <TaskRailState icon={CircleAlert} title="任务暂时不可用" detail={error} action={() => void loadWorkspace()} /> : !tasks.length ? <TaskRailState icon={CircleDashed} title={taskMode === "mine" ? "没有待处理任务" : taskMode === "available" ? "没有可承接任务" : taskMode === "handoffs" ? "没有待签收交接" : "还没有发布任务"} detail="" /> : tasks.map((task) => {
            const taskHandoffs = handoffsByPackage.get(task.id) ?? [];
            const pendingHandoff = pendingHandoffsByTask.get(task.id);
            return <article className={`task-dispatch-card is-${task.status}${task.isTemplate ? " is-template" : ""}`} key={task.id}>
            <div className="task-dispatch-top"><span className={`task-priority is-${task.priority}`}>{task.isTemplate ? "模板" : priorityCopy[task.priority]}</span><span className="task-state"><i />{task.isTemplate ? "待补充" : statusCopy[task.status]}</span></div>
            <h3>{task.title}</h3><p>{task.description}</p>
            <dl><div><dt>接收对象</dt><dd>{task.assigneeId ? peopleById.get(task.assigneeId)?.displayName ?? "已指派成员" : task.targetOrgUnitId ? `${orgUnitsById.get(task.targetOrgUnitId)?.name ?? "指定部门"}待承接` : "公司公开承接"}</dd></div><div><dt>截止</dt><dd>{formatDate(task.dueAt)}</dd></div></dl>
            <details className="task-acceptance"><summary>验收标准</summary><p>{task.acceptanceCriteria}</p></details>
            {task.isTemplate && task.missingFields.length ? <div className="task-template-missing">待补充：{task.missingFields.join("、")}</div> : null}
            {taskHandoffs.length ? <details className="task-handoff-trail"><summary>交接链 · {taskHandoffs.length} 棒{taskHandoffs.some(({ status }) => status === "pending") ? " · 待签收" : ""}</summary>{taskHandoffs.slice(-4).map((handoff) => <div className="task-handoff-line" key={handoff.id}><span>{peopleById.get(handoff.fromAssigneeId)?.displayName ?? "前负责人"}<ArrowRight size={11} />{peopleById.get(handoff.toAssigneeId)?.displayName ?? "接收人"}</span><small>{handoff.status === "pending" ? "待签收" : handoff.status === "accepted" ? "已签收" : "已退回"} · 文件/资料 {handoff.artifactRefs.length} · v{handoff.snapshot.packageVersion}</small><p>{handoff.note}</p>{handoff.responseNote ? <p className="task-handoff-response">{handoff.responseNote}</p> : null}</div>)}</details> : null}
            {taskMode === "mine" && task.assigneeId && !taskHandoffs.some(({ status }) => status === "pending") && !["in_review", "completed", "cancelled"].includes(task.status) ? <button className="task-handoff-action" type="button" onClick={() => onQueryChange(`我需要正式交接任务“${task.title}”。请先通过 work.get_task_handoff_trail 核验现有交接链和文件/资料引用，再确认交给哪位当前可用成员、交接说明和文件/资料引用；确认后用 work.initiate_task_handoff 发起版本 ${task.version} 的交接。`)}>发起交接<ArrowRight size={13} /></button> : null}
            <footer>{task.isTemplate && taskMode === "published" ? <button onClick={() => onQueryChange(`补充任务模板“${task.title}”，模板 ID 为 ${task.id}，当前版本为 ${task.version}。请先询问我想补充哪些字段，再使用 work.update_task_template 更新；不要正式分派。`)}>补充模板<ArrowRight size={13} /></button> : taskMode === "handoffs" && pendingHandoff ? <><button onClick={() => onQueryChange(`请先使用 work.get_task_handoff_trail 核验待我签收的交接 ${pendingHandoff.id} 与文件/资料引用。若信息完整，我决定签收该交接，请使用 work.respond_to_task_handoff，handoffId 为 ${pendingHandoff.id}，任务当前版本为 ${task.version}。`)}>签收交接<Check size={13} /></button><button className="task-handoff-reject" onClick={() => onQueryChange(`请先使用 work.get_task_handoff_trail 核验交接 ${pendingHandoff.id}。我需要退回此交接，请向我询问退回原因后使用 work.respond_to_task_handoff，handoffId 为 ${pendingHandoff.id}，任务当前版本为 ${task.version}。`)}>退回</button></> : taskMode === "available" ? <button disabled={busyTask === task.id} onClick={() => void claim(task)}>{busyTask === task.id ? "承接中…" : "承接"}<ArrowRight size={13} /></button> : taskMode === "mine" && ["assigned", "claimed"].includes(task.status) ? <button disabled={busyTask === task.id} onClick={() => void transition(task, "in_progress")}>开始<ArrowRight size={13} /></button> : taskMode === "mine" && task.status === "in_progress" ? <button onClick={() => onQueryChange(`任务“${task.title}”已完成执行，请使用 work.update_my_task 工具将任务 ${task.id}（当前版本 ${task.version}）提交验收，并附上证据引用：`)}>提交验收<Check size={13} /></button> : taskMode === "mine" && task.status === "blocked" ? <button disabled={busyTask === task.id} onClick={() => void transition(task, "in_progress")}>解除阻塞<ArrowRight size={13} /></button> : taskMode === "mine" && task.status === "in_review" ? <button onClick={() => onQueryChange(`任务“${task.title}”已通过验收，请使用 work.update_my_task 工具将任务 ${task.id}（当前版本 ${task.version}）标记完成，证据引用为：`)}>完成<ArrowRight size={13} /></button> : <span>{formatRelative(task.dueAt)}</span>}</footer>
          </article>})}
          </div>
        </> : <div className="message-pool-list">
          {loading && !workspace ? <TaskRailState icon={LoaderCircle} title="正在同步消息" detail="" spinning /> : error && !workspace ? <TaskRailState icon={CircleAlert} title="消息池暂时不可用" detail={error} action={() => void loadWorkspace()} /> : !workspace?.messagePools.some((pool) => pool.messages.length) ? <TaskRailState icon={MessageCircle} title="还没有沟通消息" detail="推送只用于同步、征询和反馈，不会创建任务。" /> : workspace.messagePools.map((pool) => <section className="message-pool-section" key={pool.key}><header><span>{pool.scope === "company" ? "公司" : "部门"}</span><h3>{pool.name}</h3><b>{pool.messages.length}</b></header>{pool.messages.map((message) => <article className="message-pool-card" key={message.id}><h4>{message.subject}</h4><p>{message.content}</p><footer><span>{peopleById.get(message.authorId)?.displayName ?? "成员"} · {formatTime(message.createdAt)}</span><button type="button" onClick={() => onQueryChange(`我想针对消息“${message.subject}”补充反馈。请使用 communication.add_feedback 工具向消息 ${message.id} 写入以下反馈：`)}>{message.feedback.length ? `${message.feedback.length} 条反馈` : "反馈"}</button></footer>{message.feedback.length ? <details><summary>查看反馈</summary>{message.feedback.slice(-3).map((feedback) => <p className="message-pool-feedback" key={feedback.id}><b>{peopleById.get(feedback.authorId)?.displayName ?? "成员"}</b>{feedback.content}</p>)}</details> : null}</article>)}</section>)}
        </div>}
      </aside>
    </div>
  </div>;
}

function TaskRailState({ icon: Icon, title, detail, spinning, action }: { icon: typeof CircleAlert; title: string; detail: string; spinning?: boolean; action?: () => void }) {
  return <div className="task-rail-state"><Icon className={spinning ? "spin" : ""} size={20} /><strong>{title}</strong>{detail ? <p>{detail}</p> : null}{action ? <button onClick={action}>重新连接</button> : null}</div>;
}
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatRelative(value: string) {
  const hours = Math.round((Date.parse(value) - Date.now()) / 3_600_000);
  return hours < 0 ? `逾期 ${Math.abs(hours)} 小时` : hours < 24 ? `${hours} 小时后截止` : `${Math.ceil(hours / 24)} 天后截止`;
}
