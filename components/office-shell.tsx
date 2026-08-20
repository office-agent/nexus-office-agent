"use client";

import {
  ArrowRight,
  Activity,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  Command,
  FileCheck2,
  Gauge,
  GitBranch,
  Goal,
  Inbox,
  LayoutDashboard,
  Library,
  LoaderCircle,
  LucideIcon,
  Menu,
  MessageSquareText,
  Network,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ManagementLoopView } from "@/components/management-loop-view";
import { IntegrationCenterView } from "@/components/integration-center-view";
import { GovernanceCenterView } from "@/components/governance-center-view";
import { EnterpriseIntelligenceView } from "@/components/enterprise-intelligence-view";
import { ClientPlatformView } from "@/components/client-platform-view";
import { EnterpriseGovernanceView } from "@/components/enterprise-governance-view";
import { ManagementIntelligenceView } from "@/components/management-intelligence-view";
import { PwaLifecycle } from "@/components/pwa-lifecycle";
import { WorkCommandCenter } from "@/components/work-command-center";
import { PiCodingWorkbench } from "@/components/pi-coding-workbench";
import { PiGovernanceConsole } from "@/components/pi-governance-console";
import { PiOperationsConsole } from "@/components/pi-operations-console";

type NavItem = { id: string; label: string; icon: LucideIcon };
type WorkspaceProject = {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  status: string;
  priority: string;
  health: string;
  targetEndAt: string;
};
type WorkspaceBootstrap = {
  identity: {
    tenantId: string;
    tenantName: string;
    actorId: string;
    displayName: string;
    roles: string[];
    channel: string;
  };
  projects: WorkspaceProject[];
  selectedProjectId: string | null;
  dataMode: "production" | "development_fixture";
  generatedAt: string;
};
type ManagementSnapshot = {
  objective: {
    title: string;
    description: string;
    currentValue?: number;
    targetValue?: number;
    unit?: string;
    endsAt: string;
  };
  project: WorkspaceProject & { description: string };
  risks: Array<{ id: string; title: string; description: string; probability: number; impact: number; status: string }>;
  decisions: Array<{ id: string; title: string; selectedOption?: string; rationale?: string; status: string }>;
  actionItems: Array<{ id: string; title: string; dueAt: string; status: string; acceptanceCriteria: string; completionEvidence?: string }>;
  milestones: Array<{ id: string; name: string; dueAt: string; status: string; acceptanceCriteria: string }>;
  tasks: Array<{ id: string; title: string; status: string; priority: string; dueAt?: string }>;
  issues: Array<{ id: string; title: string; severity: string; status: string }>;
  generatedAt: string;
};
type AgentCitation = { id: string; label: string; excerpt: string; objectType: string };
type AgentProposal = { id: string; proposalHash: string; preview: string; riskLevel: number; expiresAt: string; status: string };
type AgentJob = {
  id: string;
  status: "queued" | "executing" | "retry_scheduled" | "succeeded" | "failed" | "unknown" | "dead_letter" | "cancelled" | "compensated";
  attempts?: number;
  maxAttempts?: number;
  result?: unknown;
  errorCode?: string;
  unknownReason?: string;
};
type AgentMessage = {
  role: "assistant" | "user";
  content: string;
  runId?: string;
  citations?: AgentCitation[];
  proposal?: AgentProposal;
  job?: AgentJob;
  routing?: { skills: string[]; tools: string[] };
};
type PrimaryConversationWorkspace = {
  conversation: { id: string };
  messages: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    runId?: string;
    citations: AgentCitation[];
    route: { skills: string[]; tools: string[] };
  }>;
};

const primaryNav: NavItem[] = [
  { id: "command", label: "工作对话", icon: MessageSquareText },
  { id: "coding", label: "开发工作台", icon: Code2 },
  { id: "agent-governance", label: "Agent 治理", icon: ShieldCheck },
  { id: "agent-operations", label: "Agent 运营", icon: Activity },
  { id: "today", label: "管理看板", icon: LayoutDashboard },
  { id: "management-intelligence", label: "经营中枢", icon: Network },
  { id: "inbox", label: "统一收件箱", icon: Inbox },
  { id: "projects", label: "项目与任务", icon: BriefcaseBusiness },
  { id: "approvals", label: "智能审批", icon: FileCheck2 },
  { id: "people", label: "组织与人才", icon: Users },
  { id: "goals", label: "目标与绩效", icon: Goal },
  { id: "knowledge", label: "知识与会议", icon: Library },
  { id: "insights", label: "经营洞察", icon: Gauge },
  { id: "automation", label: "自动化中心", icon: GitBranch },
];

const moduleCopy: Record<string, { title: string; eyebrow: string; description: string; icon: LucideIcon }> = {
  inbox: { title: "统一收件箱", eyebrow: "跨渠道事实入口", description: "飞书、钉钉、企业微信和 Web 消息会在完成连接、身份映射和权限校验后进入这里。", icon: Inbox },
  automation: { title: "自动化中心", eyebrow: "受控执行", description: "自动化运行必须经过授权重算、幂等控制、执行回执和失败恢复。", icon: GitBranch },
};

const jobStatusCopy: Record<AgentJob["status"], string> = {
  queued: "已排队",
  executing: "执行中",
  retry_scheduled: "等待重试",
  succeeded: "有证据完成",
  failed: "执行失败",
  unknown: "结果未知",
  dead_letter: "等待人工处置",
  cancelled: "已撤销",
  compensated: "已补偿",
};
const terminalJobStatuses = new Set<AgentJob["status"]>(["succeeded", "failed", "unknown", "dead_letter", "cancelled", "compensated"]);

function subscribeToDesktopViewport(callback: () => void) {
  const media = window.matchMedia("(min-width: 761px)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
function getDesktopViewport() { return window.matchMedia("(min-width: 761px)").matches; }
function getServerDesktopViewport() { return true; }

function LogoMark() {
  return <div className="logo-mark" aria-hidden="true"><span /><span /><span /></div>;
}
function Avatar({ name }: { name: string }) {
  return <span className="avatar">{name.trim().slice(0, 1) || "用"}</span>;
}
function roleLabel(roles: string[]) {
  const labels: Record<string, string> = {
    enterprise_manager: "企业管理者",
    tenant_admin: "企业管理员",
    project_manager: "项目负责人",
  };
  return roles.map((role) => labels[role] ?? role).join(" · ") || "企业成员";
}
async function readApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "请求未完成，请稍后重试。");
  return payload.data as T;
}

export function OfficeShell() {
  const [active, setActive] = useState("command");
  const desktopViewport = useSyncExternalStore(subscribeToDesktopViewport, getDesktopViewport, getServerDesktopViewport);
  const [agentPreference, setAgentPreference] = useState<boolean | null>(null);
  const agentOpen = agentPreference ?? desktopViewport;
  const [mobileNav, setMobileNav] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [query, setQuery] = useState("");
  const [primaryConversationId, setPrimaryConversationId] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [confirmingProposal, setConfirmingProposal] = useState("");
  const [notice, setNotice] = useState("");
  const [bootstrap, setBootstrap] = useState<WorkspaceBootstrap | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ManagementSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  const monitoredJobs = useRef(new Set<string>());
  const [messages, setMessages] = useState<AgentMessage[]>([{
    role: "assistant",
    content: "你好，我是枢纽。直接告诉我你要处理的办公事项，我会在当前权限范围内找到合适的能力继续。",
  }]);

  const hydratePrimaryConversation = useCallback((conversationId: string, persistedMessages: AgentMessage[]) => {
    setPrimaryConversationId(conversationId);
    if (persistedMessages.length) setMessages(persistedMessages);
  }, []);

  const activeLabel = useMemo(() => active === "integrations" ? "系统与集成" : active === "client" ? "设备与客户端" : active === "enterprise-governance" ? "权限与治理" : primaryNav.find(({ id }) => id === active)?.label ?? "管理驾驶舱", [active]);
  const selectedProject = bootstrap?.projects.find(({ id }) => id === selectedProjectId) ?? null;
  const filteredProjects = useMemo(() => {
    const term = searchTerm.trim().toLocaleLowerCase("zh-CN");
    return term ? bootstrap?.projects.filter((project) => `${project.code} ${project.name}`.toLocaleLowerCase("zh-CN").includes(term)) ?? [] : bootstrap?.projects ?? [];
  }, [bootstrap, searchTerm]);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 3200);
  }, []);

  const loadBootstrap = useCallback(async () => {
    setBootstrapLoading(true);
    setBootstrapError("");
    try {
      const data = await readApi<WorkspaceBootstrap>("/api/v1/workspace/bootstrap", { cache: "no-store" });
      setBootstrap(data);
      setSelectedProjectId((current) => current && data.projects.some(({ id }) => id === current) ? current : data.selectedProjectId);
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : "工作区加载失败。");
      setBootstrap(null);
      setSelectedProjectId(null);
    } finally {
      setBootstrapLoading(false);
    }
  }, []);

  const loadSnapshot = useCallback(async (projectId: string) => {
    setSnapshotLoading(true);
    setSnapshotError("");
    try {
      const data = await readApi<ManagementSnapshot>(`/api/v1/management/snapshot?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      setSnapshot(data);
    } catch (error) {
      setSnapshot(null);
      setSnapshotError(error instanceof Error ? error.message : "项目管理脉络加载失败。");
    } finally {
      setSnapshotLoading(false);
    }
  }, []);

  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);
  useEffect(() => {
    // The primary conversation is application infrastructure, not a page-local widget.
    // Initialize it even on a deep-linked secondary view so every Agent entry point
    // writes to the same durable thread.
    void readApi<PrimaryConversationWorkspace>("/api/v1/task-command/workspace", { cache: "no-store" })
      .then((data) => hydratePrimaryConversation(
        data.conversation.id,
        data.messages.filter(({ role }) => role !== "tool").map((message) => ({
          role: message.role as "user" | "assistant",
          content: message.content,
          runId: message.runId,
          citations: message.citations,
          routing: message.route,
        })),
      ))
      .catch(() => undefined);
  }, [hydratePrimaryConversation]);
  useEffect(() => {
    if (selectedProjectId) void loadSnapshot(selectedProjectId);
    else {
      setSnapshot(null);
      setSnapshotError("");
    }
  }, [loadSnapshot, selectedProjectId]);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    const allowed = new Set([...primaryNav.map(({ id }) => id), "integrations", "client", "enterprise-governance"]);
    if (requested && allowed.has(requested)) setActive(requested);
    const onPopState = () => {
      const value = new URLSearchParams(window.location.search).get("view") || "command";
      if (allowed.has(value)) setActive(value);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  function chooseNav(id: string) {
    setActive(id);
    setMobileNav(false);
    const url = new URL(window.location.href);
    url.searchParams.set("view", id);
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function askAgent(event: FormEvent) {
    event.preventDefault();
    const message = query.trim();
    if (!message || isThinking) return;
    if (!primaryConversationId) { showNotice("主工作对话仍在建立，请稍后再发送"); return; }
    setMessages((current) => [...current, { role: "user", content: message }]);
    setQuery("");
    setIsThinking(true);
    try {
      const response = await fetch("/api/v1/agent/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationId: primaryConversationId, contextRefs: selectedProjectId ? [`project:${selectedProjectId}`] : [], clientRequestId: crypto.randomUUID() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "Agent 请求失败");
      const run = payload.data.run;
      setMessages((current) => [...current, {
        role: "assistant",
        content: run.output?.content || "模型没有返回可展示内容。",
        runId: run.id,
        citations: run.output?.citations,
        proposal: payload.data.proposal,
        routing: run.output?.routing,
      }]);
      window.dispatchEvent(new Event("nexus:task-command-changed"));
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: error instanceof Error ? error.message : "连接 Agent 失败，请稍后重试。" }]);
    } finally {
      setIsThinking(false);
    }
  }

  async function monitorAgentJob(jobId: string) {
    if (monitoredJobs.current.has(jobId)) return;
    monitoredJobs.current.add(jobId);
    try {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt < 6 ? 900 : 1800));
        const job = await readApi<{ job: AgentJob }>(`/api/v1/agent/jobs/${jobId}`, { cache: "no-store" }).then(({ job }) => job);
        setMessages((current) => current.map((message) => message.job?.id === jobId ? { ...message, job } : message));
        if (terminalJobStatuses.has(job.status)) {
          if (job.status === "succeeded") {
            window.dispatchEvent(new Event("nexus:management-changed"));
            if (selectedProjectId) void loadSnapshot(selectedProjectId);
            showNotice("Agent 任务已完成，业务状态已按执行结果刷新");
          } else if (job.status === "unknown") {
            showNotice("Agent 执行结果未知，必须人工核验后处置");
          } else {
            showNotice(`Agent 任务状态：${jobStatusCopy[job.status]}`);
          }
          break;
        }
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Agent 任务状态查询失败");
    } finally {
      monitoredJobs.current.delete(jobId);
    }
  }

  async function confirmAgentProposal(proposal: AgentProposal) {
    if (confirmingProposal) return;
    setConfirmingProposal(proposal.id);
    try {
      const response = await fetch(`/api/v1/agent/proposals/${proposal.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalHash: proposal.proposalHash }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "确认已失效");
      const job = payload.data.job as AgentJob;
      setMessages((current) => current.map((message) => message.proposal?.id === proposal.id
        ? { ...message, content: payload.data.run.output.content, citations: payload.data.run.output.citations, proposal: undefined, job }
        : message));
      showNotice("提案已确认并进入安全执行队列，尚未标记为成功");
      void monitorAgentJob(job.id);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Agent 操作确认失败");
    } finally {
      setConfirmingProposal("");
    }
  }

  const identity = bootstrap?.identity;
  return (
    <div className={`app-shell ${active === "command" ? "command-mode" : ""} ${active === "coding" ? "coding-mode" : ""} ${active !== "command" && active !== "coding" && agentOpen ? "with-agent" : ""}`}>
      <PwaLifecycle />
      {mobileNav ? <button className="scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} /> : null}
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand"><LogoMark /><div><strong>枢纽</strong><span>NEXUS OFFICE</span></div></div>
        <div className="workspace-switcher" aria-live="polite">
          <span className="workspace-glyph">{identity?.tenantName.slice(0, 1) || "企"}</span>
          <span><strong>{identity?.tenantName ?? (bootstrapLoading ? "正在验证身份" : "工作区不可用")}</strong><small>{bootstrap?.dataMode === "development_fixture" ? "本地验证数据 · 非生产事实" : "企业工作区"}</small></span>
          {bootstrapLoading ? <LoaderCircle className="spin" size={14} /> : <ChevronDown size={14} />}
        </div>
        <nav className="main-nav" aria-label="主导航">
          <p className="nav-caption">管理工作空间</p>
          {primaryNav.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => chooseNav(item.id)}><Icon size={17} strokeWidth={1.8} /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="sidebar-foot">
          <button className={active === "enterprise-governance" ? "active" : ""} onClick={() => chooseNav("enterprise-governance")}><ShieldCheck size={16} /><span>权限与治理</span></button>
          <button className={active === "client" ? "active" : ""} onClick={() => chooseNav("client")}><Smartphone size={16} /><span>设备与客户端</span></button>
          <button className={active === "integrations" ? "active" : ""} onClick={() => chooseNav("integrations")}><Settings size={16} /><span>系统与集成</span></button>
          <div className="account-chip"><Avatar name={identity?.displayName ?? "用户"} /><span><strong>{identity?.displayName ?? "未认证用户"}</strong><small>{identity ? roleLabel(identity.roles) : "等待身份上下文"}</small></span></div>
        </div>
      </aside>

      <main className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMobileNav(true)}><Menu size={19} /></button>
          <div className="breadcrumb"><span>{identity?.tenantName ?? "企业工作区"}</span><ChevronRight size={13} /><strong>{activeLabel}</strong></div>
          <button className="global-search" onClick={() => setSearchOpen(true)}><Search size={16} /><span>搜索已授权项目，或发起管理指令…</span><kbd><Command size={11} /> K</kbd></button>
          <div className="top-actions">{active === "command" ? <span className="command-presence"><i />在线</span> : active === "coding" ? <span className="command-presence"><i />Pi 控制面</span> : <button className="agent-toggle" aria-label={agentOpen ? "收起 AI" : "打开 AI"} onClick={() => setAgentPreference(!agentOpen)}>{agentOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}<span>{agentOpen ? "收起 AI" : "打开 AI"}</span></button>}</div>
        </header>

        <section className="content-canvas">
          {active === "command" ? <>
            {bootstrap?.dataMode === "development_fixture" ? <div className="fixture-banner"><ShieldAlert size={14} /><span><strong>本地验证模式</strong> 对话与任务记录来自开发工作区，不代表真实企业。</span></div> : null}
            <WorkCommandCenter
              messages={messages}
              query={query}
              isThinking={isThinking}
              confirmingProposal={confirmingProposal}
              onQueryChange={setQuery}
              onSubmit={askAgent}
              onConfirmProposal={(proposal) => void confirmAgentProposal(proposal)}
              onHydrate={hydratePrimaryConversation}
              onNotice={showNotice}
            />
          </> : active === "coding" ? <PiCodingWorkbench workspaceId={selectedProjectId} onNotice={showNotice} /> : active === "agent-governance" ? <PiGovernanceConsole onNotice={showNotice} /> : active === "agent-operations" ? <PiOperationsConsole /> : active === "today" ? <TodayView
            bootstrap={bootstrap}
            bootstrapLoading={bootstrapLoading}
            bootstrapError={bootstrapError}
            selectedProjectId={selectedProjectId}
            snapshot={snapshot}
            snapshotLoading={snapshotLoading}
            snapshotError={snapshotError}
            onSelectProject={setSelectedProjectId}
            onRefresh={() => bootstrapError ? void loadBootstrap() : selectedProjectId ? void loadSnapshot(selectedProjectId) : void loadBootstrap()}
            onOpenProject={() => chooseNav("projects")}
            onAsk={(text) => { chooseNav("command"); setQuery(text); }}
            onConnect={() => chooseNav("integrations")}
          /> : active === "projects" ? (
            selectedProjectId && identity ? <ManagementLoopView projectId={selectedProjectId} actorId={identity.actorId} onNotice={showNotice} /> : <ProjectRequiredState onReturn={() => chooseNav("today")} />
          ) : active === "integrations" ? <IntegrationCenterView onNotice={showNotice} />
            : active === "client" ? <ClientPlatformView onNotice={showNotice} />
              : active === "management-intelligence" ? <ManagementIntelligenceView actorId={identity?.actorId ?? null} onNotice={showNotice} />
              : active === "enterprise-governance" ? <EnterpriseGovernanceView actorId={identity?.actorId ?? null} selectedProjectId={selectedProjectId} onNotice={showNotice} />
                : active === "approvals" || active === "knowledge" ? <GovernanceCenterView onNotice={showNotice} focus={active} />
                  : active === "goals" || active === "insights" || active === "people" ? <EnterpriseIntelligenceView actorId={identity?.actorId ?? null} onNotice={showNotice} focus={active} />
                    : <ModuleBoundaryView id={active} onConnect={() => chooseNav("integrations")} />}
        </section>
      </main>

      {active !== "command" && active !== "coding" ? <aside className={`agent-panel ${agentOpen ? "agent-panel-open" : ""}`}>
        <div className="agent-head"><div className="agent-title"><span><Sparkles size={16} /></span><div><strong>企业 Agent</strong><small><i /> 权限随请求实时重算</small></div></div><button className="icon-button" aria-label="收起 AI 助手" onClick={() => setAgentPreference(false)}><X size={18} /></button></div>
        <div className="context-strip"><Network size={14} /><span>{selectedProject ? `当前上下文：${selectedProject.code} · ${selectedProject.name}` : "当前没有选择项目上下文"}</span><ShieldCheck size={13} /></div>
        <div className="conversation" aria-live="polite">
          <div className="day-divider"><span>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date())}</span></div>
          {messages.map((message, index) => <div key={`${message.runId ?? message.job?.id ?? "message"}-${index}`} className={`message ${message.role}`}>
            {message.role === "assistant" ? <span className="message-avatar"><Bot size={15} /></span> : null}
            <div>
              {message.role === "assistant" ? <span className="message-layer">{message.job ? "执行状态" : message.proposal ? "待确认提案" : message.citations?.length ? "有依据回答" : "Agent 回答"}</span> : null}
              <p>{message.content}</p>
              {message.citations?.length ? <div className="message-citations"><span><ShieldCheck size={11} />可核验依据</span>{message.citations.slice(0, 4).map((citation, citationIndex) => <details key={citation.id}><summary><b>[{citationIndex + 1}]</b>{citation.label}</summary><small>{citation.excerpt}</small></details>)}</div> : null}
              {message.proposal ? <div className="agent-proposal-card"><div><span>R{message.proposal.riskLevel} · 需要人工确认</span><b>{new Date(message.proposal.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 前有效</b></div><strong>Agent 操作提案</strong><small>{message.proposal.preview}</small><button disabled={confirmingProposal === message.proposal.id} onClick={() => void confirmAgentProposal(message.proposal!)}>{confirmingProposal === message.proposal.id ? "正在重新校验…" : "确认并排队"}<ArrowRight size={12} /></button></div> : null}
              {message.job ? <div className={`agent-job-card is-${message.job.status}`}><span><i />{jobStatusCopy[message.job.status]}</span><code>{message.job.id.slice(0, 8)}</code>{message.job.status === "unknown" ? <small>{message.job.unknownReason || "执行回执不确定，不能推断成功。"}</small> : message.job.errorCode ? <small>{message.job.errorCode}</small> : null}</div> : null}
            </div>
          </div>)}
          {isThinking ? <div className="message assistant"><span className="message-avatar"><Bot size={15} /></span><div className="thinking"><i /><i /><i /></div></div> : null}
        </div>
        <div className="prompt-suggestions">{["总结当前项目未闭环风险", "列出缺少证据的行动项", "准备项目复盘提纲"].map((text) => <button key={text} disabled={!selectedProjectId} onClick={() => setQuery(text)}>{text}</button>)}</div>
        <form className="agent-composer" onSubmit={askAgent}><textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="提问，或要求 Agent 准备一项管理动作…" rows={3} /><div><span>AI 可能出错；关键写入需确认与结果回执</span><button type="submit" className="send-button" disabled={!query.trim() || isThinking} aria-label="发送"><Send size={16} /></button></div></form>
      </aside> : null}

      {searchOpen ? <div className="command-layer" role="dialog" aria-modal="true" aria-label="全局搜索"><button className="command-scrim" aria-label="关闭搜索" onClick={() => setSearchOpen(false)} /><div className="command-box"><div className="command-input"><Search size={19} /><input autoFocus value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="搜索已授权项目…" /><kbd>ESC</kbd></div><p>{filteredProjects.length ? "可访问项目" : "没有匹配的可访问项目"}</p>{filteredProjects.map((project) => <button key={project.id} onClick={() => { setSelectedProjectId(project.id); chooseNav("projects"); setSearchOpen(false); setSearchTerm(""); }}><BriefcaseBusiness size={17} /><span><strong>{project.name}</strong><small>{project.code} · {project.health} · {project.targetEndAt}</small></span><ArrowRight size={15} /></button>)}<button onClick={() => { setSearchOpen(false); chooseNav("command"); setQuery("总结当前项目未闭环风险，并区分事实与推断"); }} disabled={!selectedProjectId}><WandSparkles size={17} /><span><strong>让 Agent 分析当前项目</strong><small>只使用当前身份可见上下文</small></span><ArrowRight size={15} /></button></div></div> : null}
      {notice ? <div className="toast"><CheckCircle2 size={17} /><span>{notice}</span></div> : null}
    </div>
  );
}

function TodayView({
  bootstrap,
  bootstrapLoading,
  bootstrapError,
  selectedProjectId,
  snapshot,
  snapshotLoading,
  snapshotError,
  onSelectProject,
  onRefresh,
  onOpenProject,
  onAsk,
  onConnect,
}: {
  bootstrap: WorkspaceBootstrap | null;
  bootstrapLoading: boolean;
  bootstrapError: string;
  selectedProjectId: string | null;
  snapshot: ManagementSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string;
  onSelectProject: (id: string | null) => void;
  onRefresh: () => void;
  onOpenProject: () => void;
  onAsk: (text: string) => void;
  onConnect: () => void;
}) {
  if (bootstrapLoading && !bootstrap) return <CockpitState icon={LoaderCircle} title="正在建立授权工作区" detail="核对企业身份、角色、数据范围与可访问项目…" spinning />;
  if (!bootstrap) return <CockpitState icon={CircleAlert} title="无法进入企业工作区" detail={bootstrapError || "没有取得有效身份上下文。"} action="重新验证" onAction={onRefresh} tone="danger" />;
  if (!bootstrap.projects.length) return <CockpitState icon={BriefcaseBusiness} title="当前没有可访问项目" detail="这里不会填充未经接口返回的记录。请先完成项目授权、创建项目，或连接企业系统后再刷新。" action="配置系统连接" onAction={onConnect} />;
  if (snapshotLoading && !snapshot) return <CockpitState icon={LoaderCircle} title="正在读取管理脉络" detail="只加载所选项目的目标、风险、决策、行动与证据。" spinning />;
  if (!snapshot) return <CockpitState icon={ShieldAlert} title="项目脉络不可用" detail={snapshotError || "该项目不存在，或当前数据范围不允许访问。"} action="重新加载" onAction={onRefresh} tone="danger" />;

  const now = new Date();
  const displayName = bootstrap.identity.displayName;
  const greeting = now.getHours() < 12 ? "早上好" : now.getHours() < 18 ? "下午好" : "晚上好";
  const openRisks = snapshot.risks.filter(({ status }) => status !== "closed").sort((a, b) => b.probability * b.impact - a.probability * a.impact);
  const openIssues = snapshot.issues.filter(({ status }) => !["resolved", "closed"].includes(status));
  const blockedTasks = snapshot.tasks.filter(({ status }) => status === "blocked");
  const pendingActions = snapshot.actionItems.filter(({ status }) => !["completed", "cancelled"].includes(status));
  const evidencedActions = snapshot.actionItems.filter(({ status, completionEvidence }) => status === "completed" && Boolean(completionEvidence));
  const exceptions = [
    ...openRisks.map((risk) => ({ id: risk.id, kind: "风险", title: risk.title, meta: `暴露度 ${risk.probability * risk.impact}/25 · ${risk.status}`, severity: risk.probability * risk.impact >= 16 ? "critical" : "warning" })),
    ...blockedTasks.map((task) => ({ id: task.id, kind: "阻塞", title: task.title, meta: task.dueAt ? `截止 ${formatDateTime(task.dueAt)}` : "未设置截止时间", severity: "critical" })),
    ...openIssues.map((issue) => ({ id: issue.id, kind: "问题", title: issue.title, meta: `${issue.severity} · ${issue.status}`, severity: "warning" })),
    ...pendingActions.map((action) => ({ id: action.id, kind: "行动", title: action.title, meta: `截止 ${formatDateTime(action.dueAt)} · 等待结果证据`, severity: "neutral" })),
  ];
  const highestRisk = openRisks[0];
  const latestDecision = snapshot.decisions.at(-1);
  const evidence = evidencedActions.at(-1);
  const inference = highestRisk
    ? `当前最值得管理者介入的是“${highestRisk.title}”：暴露度 ${highestRisk.probability * highestRisk.impact}/25。建议先核对事实与责任边界，再形成正式决策。`
    : pendingActions.length
      ? `风险记录目前没有打开项，但仍有 ${pendingActions.length} 项行动等待结果证据；项目尚未完成管理闭环。`
      : "当前项目没有打开的风险和待证据行动。下一步应核对里程碑验收与结项条件，而不是凭空生成新事项。";

  return <div className="cockpit-view">
    {bootstrap.dataMode === "development_fixture" ? <div className="fixture-banner"><ShieldAlert size={14} /><span><strong>本地验证模式</strong> 以下记录来自开发夹具，仅用于验证流程，不代表任何真实企业。</span></div> : null}
    <header className="cockpit-head">
      <div><p className="eyebrow">{new Intl.DateTimeFormat("zh-CN", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now)} · MANAGEMENT LEDGER</p><h1>{greeting}，{displayName}</h1><p>这里只呈现已授权事实、可解释推断和有明确状态的执行任务。</p></div>
      <div className="cockpit-controls"><label><span>当前项目</span><select value={selectedProjectId ?? ""} onChange={(event) => onSelectProject(event.target.value || null)}>{bootstrap.projects.map((project) => <option value={project.id} key={project.id}>{project.code} · {project.name}</option>)}</select></label><button onClick={onRefresh} disabled={snapshotLoading}><RefreshCw className={snapshotLoading ? "spin" : ""} size={14} />刷新事实</button></div>
    </header>

    <section className="cockpit-project-bar">
      <div><span>{snapshot.project.code}</span><h2>{snapshot.project.name}</h2><p>{snapshot.project.description}</p></div>
      <div className="project-commitment"><small>承诺日期</small><strong>{snapshot.project.targetEndAt}</strong><span className={`health-chip is-${snapshot.project.health}`}><i />{snapshot.project.health}</span></div>
    </section>

    <section className="closure-track" aria-label="管理闭环轨道">
      <ClosureNode index="01" label="目标" title={snapshot.objective.title} meta={`目标 ${valueWithUnit(snapshot.objective.targetValue, snapshot.objective.unit)} · 截止 ${snapshot.objective.endsAt}`} tone="objective" />
      <ClosureNode index="02" label="风险" title={highestRisk?.title ?? "没有打开的风险"} meta={highestRisk ? `事实记录 · 暴露度 ${highestRisk.probability * highestRisk.impact}/25` : "等待新的正式风险信号"} tone={highestRisk ? "risk" : "quiet"} />
      <ClosureNode index="03" label="决策" title={latestDecision?.title ?? "尚未形成正式决策"} meta={latestDecision?.selectedOption ? `已选择：${latestDecision.selectedOption}` : "决策必须由责任人确认"} tone={latestDecision ? "decision" : "quiet"} />
      <ClosureNode index="04" label="行动" title={pendingActions[0]?.title ?? "没有待完成行动"} meta={pendingActions[0] ? `截止 ${formatDateTime(pendingActions[0].dueAt)}` : "责任、时限和验收标准完整"} tone={pendingActions.length ? "action" : "quiet"} />
      <ClosureNode index="05" label="证据" title={evidence?.title ?? "等待可核验结果"} meta={evidence?.completionEvidence ?? "完成不等于闭环，必须提交证据"} tone={evidence ? "evidence" : "quiet"} />
    </section>

    <section className="cockpit-fact-strip">
      <div><span>打开风险</span><strong>{openRisks.length}</strong><small>来自正式风险记录</small></div>
      <div><span>阻塞与问题</span><strong>{blockedTasks.length + openIssues.length}</strong><small>需要例外管理</small></div>
      <div><span>待证据行动</span><strong>{pendingActions.length}</strong><small>尚未验真</small></div>
      <div><span>已留证行动</span><strong>{evidencedActions.length}</strong><small>可回溯结果</small></div>
    </section>

    <div className="cockpit-grid">
      <section className="ledger-panel exception-panel">
        <header><div><p>MANAGEMENT EXCEPTIONS</p><h2>需要介入的例外</h2></div><span>{exceptions.length} 项</span></header>
        {exceptions.length ? <div className="exception-list">{exceptions.slice(0, 8).map((item) => <article key={`${item.kind}-${item.id}`} className={`is-${item.severity}`}><span>{item.kind}</span><div><strong>{item.title}</strong><small>{item.meta}</small></div><ChevronRight size={15} /></article>)}</div> : <div className="ledger-empty"><CheckCircle2 size={22} /><strong>没有打开的管理例外</strong><span>系统未返回需要当前管理者介入的风险、阻塞、问题或待证据行动。</span></div>}
        <footer><button onClick={onOpenProject}>进入项目闭环 <ArrowRight size={14} /></button><small>事实时间：{formatDateTime(snapshot.generatedAt)}</small></footer>
      </section>

      <aside className="ledger-panel agent-judgement">
        <header><div><p>AGENT INFERENCE</p><h2>可解释管理判断</h2></div><Sparkles size={17} /></header>
        <div className="judgement-layer"><span>推断</span><p>{inference}</p></div>
        <div className="judgement-evidence"><strong>推断所用事实</strong><ul><li>打开风险 {openRisks.length} 项</li><li>阻塞任务 {blockedTasks.length} 项</li><li>未闭环问题 {openIssues.length} 项</li><li>待证据行动 {pendingActions.length} 项</li></ul></div>
        <button onClick={() => onAsk(`分析项目“${snapshot.project.name}”的未闭环风险，严格区分事实、推断和建议`)}>要求 Agent 展开依据 <ArrowRight size={14} /></button>
      </aside>
    </div>
  </div>;
}

function ClosureNode({ index, label, title, meta, tone }: { index: string; label: string; title: string; meta: string; tone: string }) {
  return <article className={`closure-node is-${tone}`}><div><span>{index}</span><i /></div><small>{label}</small><strong>{title}</strong><p>{meta}</p></article>;
}

function CockpitState({ icon: Icon, title, detail, action, onAction, spinning = false, tone = "neutral" }: { icon: LucideIcon; title: string; detail: string; action?: string; onAction?: () => void; spinning?: boolean; tone?: "neutral" | "danger" }) {
  return <div className={`cockpit-state is-${tone}`}><Icon className={spinning ? "spin" : ""} size={24} /><h1>{title}</h1><p>{detail}</p>{action && onAction ? <button onClick={onAction}>{action}<ArrowRight size={14} /></button> : null}</div>;
}

function ProjectRequiredState({ onReturn }: { onReturn: () => void }) {
  return <CockpitState icon={BriefcaseBusiness} title="先选择一个可访问项目" detail="项目管理闭环不会隐式选择预置项目。请回到驾驶舱，从授权目录中选择项目。" action="返回驾驶舱" onAction={onReturn} />;
}

function ModuleBoundaryView({ id, onConnect }: { id: string; onConnect: () => void }) {
  const copy = moduleCopy[id] ?? moduleCopy.inbox;
  const Icon = copy.icon;
  return <div className="module-boundary"><div className="module-boundary-mark"><Icon size={22} /></div><p className="eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p>{copy.description}</p><div className="module-boundary-state"><ShieldCheck size={17} /><div><strong>没有伪造业务记录</strong><span>该业务域尚未接入首页查询契约；完成真实连接和授权后才会展示数据。</span></div></div><button onClick={onConnect}>前往系统与集成 <ArrowRight size={14} /></button></div>;
}

function valueWithUnit(value?: number, unit?: string) {
  return value === undefined ? "待设置" : `${value}${unit ?? ""}`;
}
function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
