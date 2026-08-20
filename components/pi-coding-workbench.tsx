"use client";

import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Code2,
  FileDiff,
  GitBranch,
  GitFork,
  LoaderCircle,
  Package,
  PauseCircle,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  XCircle,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type PiProfile = {
  id: string;
  version: number;
  digest: string;
  description: string;
  allowedTools: string[];
  allowedDataScopes: Array<{ type: string; projectIds?: string[]; resourceIds?: string[]; teamIds?: string[]; orgUnitIds?: string[] }>;
  maxRiskLevel: string;
  networkPolicy: "none" | "allowlist" | "restricted";
  canModifyWorkspace: boolean;
  canExecuteSandbox: boolean;
  delegationPolicy: { maxDepth: number; maxConcurrentChildren: number; allowedProfiles: string[]; budget: { maxDurationMs: number; maxOutputBytes: number; maxTokens: number; maxChildRuns: number } };
};

type PiSession = {
  id: string;
  workspaceId: string;
  repositoryId?: string;
  baseRef?: string;
  baseCommit?: string;
  profile: string;
  profileVersion: number;
  status: string;
  modelPolicy: string;
  sandboxProfile: string;
  networkPolicy: "none" | "allowlist" | "restricted";
  policyVersion: number;
  skillDigests: string[];
  mcpServerDigests: string[];
  mcpBindingIds: string[];
  traceId: string;
  lastEventSequence: number;
  createdAt: string;
  updatedAt: string;
};

type PiEvent = {
  id: string;
  sequence: number;
  type: string;
  traceId: string;
  createdAt: string;
};

type PiBranch = {
  id: string;
  parentBranchId?: string;
  baseEventSequence: number;
  headEventSequence: number;
  label: string;
  status: "active" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
};

type PiSummary = { id: string; branchId: string; sourceStartSequence: number; sourceEndSequence: number; summaryDigest: string; compactionVersion: number; createdAt: string };
type PiTree = { rootBranch: PiBranch; branches: PiBranch[]; summaries: PiSummary[]; continuityDigest: string };
type PiRun = { runId: string; type: string; status: string; createdAt: string; updatedAt: string; payload: { message?: string; reason?: string } };
type PiRunDetail = { status: string };
type PiDiff = { diff: string; digest: string; files: unknown[] };
type PiArtifact = { id: string; fileName: string; type: string; sizeBytes: number; status: string; contentDigest: string; createdAt: string };
type PiCheckpoint = { id: string; label: string; gitCommitSha?: string; diffDigest: string; createdAt: string };
type PiAcceptedRun = { runId: string; commandId: string; status: string; created: boolean; session: PiSession };

type PromptRecord = { id: string; text: string; createdAt: string; runId: string };

class PiApiError extends Error {
  constructor(message: string, readonly code = "PI_REQUEST_FAILED", readonly status = 500) {
    super(message);
    this.name = "PiApiError";
  }
}

async function readPiApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as { data?: T; error?: { code?: string; message?: string } };
  if (!response.ok) throw new PiApiError(payload.error?.message ?? "Pi 请求未完成。", payload.error?.code, response.status);
  return payload.data as T;
}

const profileLabels: Record<string, string> = {
  coding: "编码",
  review: "审查",
  debug: "调试",
  refactor: "重构",
  office: "办公",
  integration: "集成",
  release: "发布提案",
};

const statusLabels: Record<string, string> = {
  created: "等待输入",
  queued: "已排队",
  provisioning: "准备沙盒",
  running: "执行中",
  awaiting_approval: "等待审批",
  cancelling: "正在取消",
  completed: "已完成",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "已超时",
  unknown: "结果未知",
  accepted: "已接受",
  leased: "Worker 已领取",
  acknowledged: "已回执",
  cancel_requested: "取消已请求",
  dead_lettered: "等待人工处置",
};

const eventLabels: Record<string, string> = {
  session_created: "Session 已创建",
  message_accepted: "消息已进入队列",
  checkpoint_requested: "Checkpoint 已请求",
  interrupt_requested: "中断已请求",
  cancel_requested: "取消已请求",
  "pi.session.branch_created": "Session 分支已创建",
  "pi.context.compacted": "上下文摘要已写入",
};

function profileLabel(id: string): string { return profileLabels[id] ?? id; }
function statusLabel(status: string): string { return statusLabels[status] ?? status; }
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function shortDigest(value?: string): string { return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "未生成"; }
function statusTone(status: string): "idle" | "active" | "paused" | "unknown" | "terminal" | "danger" {
  if (["running", "provisioning", "leased", "acknowledged"].includes(status)) return "active";
  if (["awaiting_approval", "cancelling", "cancel_requested"].includes(status)) return "paused";
  if (status === "unknown") return "unknown";
  if (["failed", "timed_out", "dead_lettered"].includes(status)) return "danger";
  if (["completed", "succeeded", "cancelled"].includes(status)) return "terminal";
  return "idle";
}

export function PiCodingWorkbench({ workspaceId, onNotice }: { workspaceId: string | null; onNotice: (message: string) => void }) {
  const [profiles, setProfiles] = useState<PiProfile[]>([]);
  const [profilesError, setProfilesError] = useState("");
  const [sessions, setSessions] = useState<PiSession[]>([]);
  const [sessionsError, setSessionsError] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTree, setSelectedTree] = useState<PiTree | null>(null);
  const [events, setEvents] = useState<PiEvent[]>([]);
  const [runs, setRuns] = useState<PiRun[]>([]);
  const [runDetail, setRunDetail] = useState<PiRunDetail | null>(null);
  const [localPrompts, setLocalPrompts] = useState<PromptRecord[]>([]);
  const [draft, setDraft] = useState("");
  const [newProfile, setNewProfile] = useState("coding");
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [treeAction, setTreeAction] = useState("");
  const [connection, setConnection] = useState<"idle" | "connecting" | "connected" | "reconnecting" | "error">("idle");
  const [detailError, setDetailError] = useState("");
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [diff, setDiff] = useState<PiDiff | null>(null);
  const [artifacts, setArtifacts] = useState<PiArtifact[]>([]);
  const [checkpoints, setCheckpoints] = useState<PiCheckpoint[]>([]);
  const [deliveryLoaded, setDeliveryLoaded] = useState(false);
  const [deliveryError, setDeliveryError] = useState("");
  const cursorRef = useRef(0);

  const selectedSession = useMemo(() => sessions.find((session) => session.id === selectedSessionId) ?? null, [selectedSessionId, sessions]);
  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === (selectedSession?.profile ?? newProfile)) ?? null, [newProfile, profiles, selectedSession]);
  const latestRun = runs[0] ?? null;
  const effectiveStatus = runDetail?.status ?? selectedSession?.status ?? "created";
  const tone = statusTone(effectiveStatus);
  const canInterrupt = Boolean(selectedSession && ["queued", "provisioning", "running", "awaiting_approval"].includes(selectedSession.status) && latestRun);

  const refreshSessions = useCallback(async () => {
    setSessionsError("");
    try {
      const next = await readPiApi<PiSession[]>("/api/v1/pi/sessions", { cache: "no-store" });
      setSessions(next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setSelectedSessionId((current) => current && next.some((session) => session.id === current) ? current : next[0]?.id ?? null);
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : "Session 列表加载失败。");
    }
  }, []);

  const refreshProfiles = useCallback(async () => {
    setProfilesError("");
    try {
      const next = await readPiApi<PiProfile[]>("/api/v1/pi/catalog/profiles", { cache: "no-store" });
      setProfiles(next);
      setNewProfile((current) => next.some((profile) => profile.id === current) ? current : next[0]?.id ?? "coding");
    } catch (error) {
      setProfilesError(error instanceof Error ? error.message : "Profile 目录加载失败。");
    }
  }, []);

  const refreshSelected = useCallback(async (sessionId: string) => {
    setDetailError("");
    try {
      const [session, tree, nextRuns] = await Promise.all([
        readPiApi<PiSession>(`/api/v1/pi/sessions/${sessionId}`, { cache: "no-store" }),
        readPiApi<PiTree>(`/api/v1/pi/sessions/${sessionId}/tree`, { cache: "no-store" }),
        readPiApi<PiRun[]>(`/api/v1/pi/sessions/${sessionId}/runs`, { cache: "no-store" }),
      ]);
      setSessions((current) => current.some((item) => item.id === session.id) ? current.map((item) => item.id === session.id ? session : item) : [session, ...current]);
      setSelectedTree(tree);
      const orderedRuns = [...nextRuns].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      setRuns(orderedRuns);
      const currentRun = orderedRuns[0];
      if (currentRun) {
        const detail = await readPiApi<PiRunDetail>(`/api/v1/pi/runs/${currentRun.runId}`, { cache: "no-store" });
        setRunDetail(detail);
      } else {
        setRunDetail(null);
      }
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Session 详情加载失败。");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshProfiles();
      void refreshSessions();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshProfiles, refreshSessions]);

  useEffect(() => {
    if (!selectedSessionId) {
      const timer = window.setTimeout(() => {
        setSelectedTree(null);
        setEvents([]);
        setRuns([]);
        setRunDetail(null);
        setLocalPrompts([]);
        setDiff(null);
        setArtifacts([]);
        setCheckpoints([]);
        setDeliveryLoaded(false);
        setDeliveryError("");
        cursorRef.current = 0;
        setConnection("idle");
      }, 0);
      return () => window.clearTimeout(timer);
    }
    let disposed = false;
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    const bootTimer = window.setTimeout(() => {
      setEvents([]);
      setLocalPrompts([]);
      setDiff(null);
      setArtifacts([]);
      setCheckpoints([]);
      setDeliveryLoaded(false);
      setDeliveryError("");
      cursorRef.current = 0;
      setConnection("connecting");
      void refreshSelected(selectedSessionId);
    }, 0);

    const connect = () => {
      if (disposed) return;
      source = new EventSource(`/api/v1/pi/sessions/${selectedSessionId}/events?after=${cursorRef.current}`);
      source.addEventListener("ready", () => { if (!disposed) setConnection("connected"); });
      source.addEventListener("pi-event", (message) => {
        try {
          const event = JSON.parse((message as MessageEvent<string>).data) as PiEvent;
          if (!event?.id || event.sequence <= cursorRef.current) return;
          cursorRef.current = event.sequence;
          setEvents((current) => [...current.filter((item) => item.id !== event.id), event].sort((left, right) => left.sequence - right.sequence));
          void refreshSelected(selectedSessionId);
        } catch {
          setConnection("error");
        }
      });
      source.addEventListener("stream-error", () => { if (!disposed) setConnection("error"); });
      source.onerror = () => {
        if (disposed) return;
        source?.close();
        setConnection("reconnecting");
        retryTimer = window.setTimeout(connect, 1_500);
      };
    };
    connect();
    return () => {
      disposed = true;
      source?.close();
      if (retryTimer) window.clearTimeout(retryTimer);
      window.clearTimeout(bootTimer);
    };
  }, [refreshSelected, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const timer = window.setInterval(() => void refreshSelected(selectedSessionId), 4_000);
    return () => window.clearInterval(timer);
  }, [refreshSelected, selectedSessionId]);

  async function createSession(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId) {
      onNotice("请先在管理看板选择一个已授权项目作为代码工作区");
      return;
    }
    setCreating(true);
    try {
      const session = await readPiApi<PiSession>("/api/v1/pi/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: newProfile, workspaceId }),
      });
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSelectedSessionId(session.id);
      onNotice(`已创建 ${profileLabel(session.profile)} Session；等待 Runner 接管`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Session 创建失败。");
    } finally {
      setCreating(false);
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!selectedSession || !message || sending) return;
    setSending(true);
    try {
      const accepted = await readPiApi<PiAcceptedRun>(`/api/v1/pi/sessions/${selectedSession.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ message }),
      });
      setLocalPrompts((current) => [...current, { id: crypto.randomUUID(), text: message, createdAt: new Date().toISOString(), runId: accepted.runId }]);
      setSessions((current) => current.map((item) => item.id === accepted.session.id ? accepted.session : item));
      setDraft("");
      onNotice(accepted.created ? "指令已进入 Pi 队列；模型回执仍需等待 Runner 事件" : "重复指令已返回原 Run；未新增副作用");
      void refreshSelected(selectedSession.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "消息未能进入 Pi 队列。");
    } finally {
      setSending(false);
    }
  }

  async function interruptSession() {
    if (!selectedSession || interrupting) return;
    setInterrupting(true);
    try {
      const accepted = await readPiApi<PiAcceptedRun>(`/api/v1/pi/sessions/${selectedSession.id}/interrupt`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      setSessions((current) => current.map((item) => item.id === accepted.session.id ? accepted.session : item));
      onNotice("中断请求已记录；最终状态以 Runner 回执为准");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "中断请求失败。");
    } finally {
      setInterrupting(false);
    }
  }

  async function forkSession() {
    if (!selectedSession || !selectedTree || treeAction) return;
    setTreeAction("fork");
    try {
      const branch = await readPiApi<PiBranch>(`/api/v1/pi/sessions/${selectedSession.id}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ parentBranchId: selectedTree.rootBranch.id, label: `分支 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }).replaceAll(":", "-")}` }),
      });
      onNotice(`已创建分支 ${branch.label}；不会自动合并主线`);
      await refreshSelected(selectedSession.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "分支创建失败。");
    } finally {
      setTreeAction("");
    }
  }

  async function resumeSession() {
    if (!selectedSession || treeAction) return;
    setTreeAction("resume");
    try {
      await readPiApi(`/api/v1/pi/sessions/${selectedSession.id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branchId: selectedTree?.rootBranch.id }) });
      onNotice("已从服务端历史重建当前分支；没有推断缺失的模型输出");
      await refreshSelected(selectedSession.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Session 恢复失败。");
    } finally {
      setTreeAction("");
    }
  }

  async function compactSession() {
    if (!selectedSession || treeAction) return;
    setTreeAction("compact");
    try {
      await readPiApi(`/api/v1/pi/sessions/${selectedSession.id}/compact`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ branchId: selectedTree?.rootBranch.id, maxEvents: 200 }) });
      onNotice("上下文摘要已写入；原始事件仍保留");
      await refreshSelected(selectedSession.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "上下文压缩失败。");
    } finally {
      setTreeAction("");
    }
  }

  async function loadDelivery() {
    if (!selectedSession || deliveryLoading) return;
    setDeliveryLoading(true);
    setDeliveryError("");
    try {
      const [nextDiff, nextArtifacts, nextCheckpoints] = await Promise.all([
        readPiApi<PiDiff>(`/api/v1/pi/sessions/${selectedSession.id}/diff`, { cache: "no-store" }),
        readPiApi<PiArtifact[]>(`/api/v1/pi/sessions/${selectedSession.id}/artifacts`, { cache: "no-store" }),
        readPiApi<PiCheckpoint[]>(`/api/v1/pi/sessions/${selectedSession.id}/checkpoints`, { cache: "no-store" }),
      ]);
      setDiff(nextDiff);
      setArtifacts(nextArtifacts);
      setCheckpoints(nextCheckpoints);
      setDeliveryLoaded(true);
    } catch (error) {
      setDeliveryLoaded(false);
      setDeliveryError(error instanceof Error ? error.message : "交付物读取失败。");
    } finally {
      setDeliveryLoading(false);
    }
  }

  return <div className="pi-workbench">
    <header className="pi-workbench-header">
      <div>
        <p className="eyebrow">PI ENTERPRISE RUNTIME · M29 EMPLOYEE WORKBENCH</p>
        <h1>开发工作台</h1>
        <p>用统一 Pi Agent 读取代码、提出变更并追踪可验证的运行事件。对话、权限和交付状态都以服务端事实为准。</p>
      </div>
      <div className="pi-workbench-header-status"><span className={`pi-status-dot is-${connection}`} /><span>{connection === "connected" ? "事件流已连接" : connection === "reconnecting" ? "事件流重连中" : connection === "error" ? "事件流异常" : "等待事件流"}</span><small>{workspaceId ? `工作区 ${workspaceId.slice(0, 8)}…` : "未选择工作区"}</small></div>
    </header>

    {profilesError || sessionsError ? <div className="pi-workbench-alert is-danger"><ShieldAlert size={15} /><span>{profilesError || sessionsError}</span><button onClick={() => { void refreshProfiles(); void refreshSessions(); }}>重新加载</button></div> : null}

    <div className="pi-workbench-grid">
      <aside className="pi-session-rail">
        <header><div><span className="pi-rail-kicker">SESSION INDEX</span><h2>我的开发会话</h2></div><button className="pi-icon-button" onClick={() => void refreshSessions()} aria-label="刷新会话" title="刷新会话"><RefreshCw size={15} /></button></header>
        <form className="pi-session-create" onSubmit={createSession}>
          <label><span>新建 Profile</span><select value={newProfile} onChange={(event) => setNewProfile(event.target.value)} disabled={!profiles.length || creating}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profileLabel(profile.id)}</option>)}</select></label>
          <p>{workspaceId ? "使用当前已授权项目作为 workspace；租户和权限由服务端解析。" : "请先在管理看板选择已授权项目，不能由客户端猜测工作区。"}</p>
          <button className="pi-primary-button" type="submit" disabled={!workspaceId || !profiles.length || creating}>{creating ? <LoaderCircle className="spin" size={14} /> : <Code2 size={14} />}{creating ? "创建中…" : "新建 Session"}<ArrowRight size={13} /></button>
        </form>
        <div className="pi-session-list" aria-label="开发会话列表">
          {sessions.length ? sessions.map((session) => <button key={session.id} className={`pi-session-item ${selectedSessionId === session.id ? "is-selected" : ""}`} onClick={() => setSelectedSessionId(session.id)}><span className="pi-session-item-top"><b>{profileLabel(session.profile)}</b><i className={`is-${statusTone(session.status)}`} /> </span><strong>{session.workspaceId}</strong><small>{statusLabel(session.status)} · {formatTime(session.updatedAt)}</small><code>{session.id.slice(0, 8)}</code></button>) : <div className="pi-empty-rail"><CircleAlert size={18} /><strong>还没有 Session</strong><span>创建后，服务端会建立独立会话事实和事件游标。</span></div>}
        </div>
      </aside>

      <main className="pi-dialog-panel">
        {!selectedSession ? <div className="pi-empty-main"><div className="pi-empty-glyph"><Code2 size={27} /></div><p className="eyebrow">DIALOG-FIRST CODING</p><h2>从一个真实工作区开始</h2><p>先选择项目，再创建 Profile 受控的 Pi Session。页面不会预填代码、模型输出或沙盒结果。</p><div className="pi-empty-facts"><span><ShieldCheck size={14} />租户与权限服务端解析</span><span><Terminal size={14} />Shell 仅在沙盒能力就绪后执行</span><span><GitBranch size={14} />变更默认停留在临时分支</span></div></div> : <>
          <header className="pi-dialog-header"><div><p className="pi-rail-kicker">ACTIVE SESSION · {selectedSession.id.slice(0, 8)}</p><h2>{profileLabel(selectedSession.profile)} Agent <span>/ {selectedSession.workspaceId}</span></h2><div className="pi-session-tags"><span>Profile v{selectedSession.profileVersion}</span><span>Policy v{selectedSession.policyVersion}</span><span>网络：{selectedSession.networkPolicy === "none" ? "默认断网" : selectedSession.networkPolicy}</span><span>事件 #{selectedSession.lastEventSequence}</span></div></div><div className="pi-dialog-actions"><button className="pi-secondary-button" onClick={() => void refreshSelected(selectedSession.id)}><RefreshCw size={13} />刷新</button><button className="pi-danger-button" onClick={() => void interruptSession()} disabled={!canInterrupt || interrupting}>{interrupting ? <LoaderCircle className="spin" size={13} /> : <PauseCircle size={13} />}{interrupting ? "请求中" : "中断"}</button></div></header>

          <section className="pi-runtime-pulse" aria-label="运行脉冲轨道"><div className="pi-pulse-heading"><span>运行脉冲轨道</span><strong className={`is-${tone}`}><i />{statusLabel(effectiveStatus)}</strong></div><div className="pi-pulse-track"><span className={tone === "idle" ? "is-current" : ""}><i />排队</span><b /><span className={tone === "active" ? "is-current" : ""}><i />运行</span><b /><span className={tone === "paused" ? "is-current" : ""}><i />暂停</span><b /><span className={tone === "unknown" ? "is-current" : ""}><i />未知</span><b /><span className={tone === "terminal" || tone === "danger" ? "is-current" : ""}><i />终态</span></div><small>{runDetail ? `Run ${latestRun?.runId.slice(0, 8) ?? ""} · 服务端状态 ${statusLabel(runDetail.status)}` : "当前没有可读取的 Run 回执；不能推断 Agent 已运行。"}</small></section>

          {detailError ? <div className="pi-workbench-alert is-danger"><ShieldAlert size={15} /><span>{detailError}</span><button onClick={() => void refreshSelected(selectedSession.id)}>重试</button></div> : null}
          <div className="pi-conversation-stream" aria-live="polite">
            {localPrompts.map((prompt) => <article className="pi-message is-user" key={prompt.id}><span className="pi-message-label">你 · {formatTime(prompt.createdAt)}</span><p>{prompt.text}</p><small>已提交至 Run {prompt.runId.slice(0, 8)}；这是当前页面的输入记录。</small></article>)}
            {events.map((event) => <article className="pi-event-card" key={event.id}><span className="pi-event-sequence">#{event.sequence}</span><div><strong>{eventLabels[event.type] ?? event.type}</strong><small>{formatTime(event.createdAt)} · trace {event.traceId.slice(0, 10)}…</small></div><CircleDot size={14} /></article>)}
            {!events.length && !localPrompts.length ? <div className="pi-stream-empty"><CircleDot size={20} /><strong>等待第一条服务端事件</strong><span>提交消息后，事件流会按游标追加；断线重连从最后序号继续。</span></div> : null}
            {events.length && !runDetail && latestRun ? <div className="pi-stream-pending"><LoaderCircle className="spin" size={15} />已排队，尚未收到 Runner 回执。系统不会把排队当作执行成功。</div> : null}
          </div>
          <form className="pi-composer" onSubmit={sendMessage}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="告诉 Pi Agent 要读取、修改或验证什么…" rows={3} disabled={sending} /><footer><span><ShieldCheck size={12} />不会在浏览器保存密钥、代码副本或执行凭据</span><button className="pi-primary-button" type="submit" disabled={!draft.trim() || sending}>{sending ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}{sending ? "排队中…" : "发送到 Pi"}</button></footer></form>
        </>}
      </main>

      <aside className="pi-capability-drawer">
        <section className="pi-drawer-card pi-profile-card"><header><div><span className="pi-rail-kicker">CAPABILITY SNAPSHOT</span><h2>能力边界</h2></div><ShieldCheck size={16} /></header>{selectedProfile ? <><div className="pi-profile-title"><span>{profileLabel(selectedProfile.id)}</span><b>R{selectedProfile.maxRiskLevel.slice(-1)}</b></div><p>{selectedProfile.description}</p><dl><div><dt>工具</dt><dd>{selectedProfile.allowedTools.length}</dd></div><div><dt>沙盒</dt><dd>{selectedProfile.canExecuteSandbox ? "允许" : "关闭"}</dd></div><div><dt>网络</dt><dd>{selectedProfile.networkPolicy === "none" ? "断网" : selectedProfile.networkPolicy}</dd></div></dl><div className="pi-tool-chips">{selectedProfile.allowedTools.length ? selectedProfile.allowedTools.map((tool) => <span key={tool}>{tool}</span>) : <span>没有暴露 Tool</span>}</div><small className="pi-digest-line">Profile digest · {shortDigest(selectedProfile.digest)}</small></> : <div className="pi-card-empty"><CircleAlert size={15} />未取得 Profile 能力快照</div>}</section>

        <section className="pi-drawer-card"><header><div><span className="pi-rail-kicker">TREE / RECOVERY</span><h2>会话树与恢复</h2></div><GitBranch size={16} /></header>{selectedTree ? <><div className="pi-tree-stat"><span><b>{selectedTree.branches.length}</b> 分支</span><span><b>{selectedTree.summaries.length}</b> 摘要</span><span><b>{selectedTree.rootBranch.headEventSequence}</b> HEAD</span></div><p className="pi-continuity"><CheckCircle2 size={13} />连续性摘要 {shortDigest(selectedTree.continuityDigest)}</p><div className="pi-branch-list">{selectedTree.branches.slice(0, 4).map((branch) => <div key={branch.id}><span><GitBranch size={12} />{branch.label}</span><small>v{branch.version} · {branch.status === "active" ? "活动" : "已归档"}</small></div>)}</div><div className="pi-action-row"><button onClick={() => void forkSession()} disabled={Boolean(treeAction)}><GitFork size={13} />{treeAction === "fork" ? "创建中" : "建分支"}</button><button onClick={() => void resumeSession()} disabled={Boolean(treeAction)}><RotateCcw size={13} />{treeAction === "resume" ? "恢复中" : "恢复"}</button><button onClick={() => void compactSession()} disabled={Boolean(treeAction) || !events.length}><Sparkles size={13} />{treeAction === "compact" ? "摘要中" : "压缩"}</button></div></> : <div className="pi-card-empty"><LoaderCircle className="spin" size={15} />读取会话树…</div>}</section>

        <section className="pi-drawer-card pi-delivery-card"><header><div><span className="pi-rail-kicker">DELIVERY RAIL</span><h2>变更交付</h2></div><FileDiff size={16} /></header><p>读取 Diff、Checkpoint 和 Artifact；合并、发布与外发仍由独立 Gate 控制。</p><button className="pi-secondary-button pi-wide-button" onClick={() => void loadDelivery()} disabled={!selectedSession || deliveryLoading}>{deliveryLoading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{deliveryLoading ? "读取中…" : "读取当前交付物"}</button>{deliveryError ? <div className="pi-inline-error"><XCircle size={13} />{deliveryError}</div> : null}<div className="pi-delivery-facts"><div><FileDiff size={13} /><span>Diff<b>{diff ? `${diff.files.length} 文件` : "未读取"}</b></span></div><div><Package size={13} /><span>Artifact<b>{deliveryLoaded ? `${artifacts.length} 个` : "未读取"}</b></span></div><div><GitBranch size={13} /><span>Checkpoint<b>{deliveryLoaded ? `${checkpoints.length} 个` : "未读取"}</b></span></div></div>{diff ? <small className="pi-digest-line">Diff digest · {shortDigest(diff.digest)}</small> : null}<div className="pi-delivery-blocked"><ShieldAlert size={13} /><span>submit-change / PR / merge / release 等写入能力等待 G-030/G-031，不在客户端绕过。</span></div></section>
      </aside>
    </div>
  </div>;
}
