"use client";

import {
  ChevronRight,
  CircleDashed,
  CircleOff,
  Clock3,
  Database,
  Fingerprint,
  LockKeyhole,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type Profile = {
  id: string;
  version: number;
  digest: string;
  description: string;
  allowedTools: string[];
  maxRiskLevel: string;
  networkPolicy: string;
  canModifyWorkspace: boolean;
  canExecuteSandbox: boolean;
  delegationPolicy: { maxDepth: number; maxConcurrentChildren: number; allowedProfiles: string[]; budget: { maxTokens: number; maxChildRuns: number } };
};
type Skill = {
  id: string;
  skillId: string;
  version: string;
  scope: string;
  digest: string;
  requiredTools: string[];
  dataClassification: string;
  riskLevel: string;
  allowedProfiles: string[];
  approvalStatus: string;
  rolloutPercent: number;
  createdAt: string;
};
type Artifact = {
  id: string;
  resourceId: string;
  kind: "package" | "extension";
  version: string;
  digest: string;
  scanStatus: string;
  approvalStatus: string;
  rolloutPercent: number;
  allowedProfiles: string[];
  dataClassification: string;
  riskLevel: string;
  createdAt: string;
};
type McpServer = {
  id: string;
  version: string;
  source: string;
  digest: string;
  approvalStatus: string;
  schemaDigest?: string;
  toolCount: number;
  circuitState: string;
  failureCount: number;
  createdAt: string;
  probedAt?: string;
};
type McpBinding = {
  id: string;
  serverId: string;
  serverVersion: string;
  serverDigest: string;
  toolName: string;
  exposedName: string;
  schemaDigest: string;
  riskLevel: string;
  dataClassification: string;
  allowedProfiles: string[];
  scope: { type: string; projectId?: string; actorId?: string };
  status: string;
  createdAt: string;
  updatedAt: string;
};
type GovernanceSnapshot = {
  profiles: Profile[];
  resources: { skills: Skill[]; artifacts: Artifact[] };
  mcp: { servers: McpServer[]; bindings: McpBinding[] };
  capabilities: { canReadRegistry: boolean; canManageMcp: boolean; canPublishRegistry: boolean; canApproveRegistry: boolean; canScanRegistry: boolean; canManageProfiles: boolean };
};

async function readApi<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json() as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "治理视图读取失败");
  if (!payload.data) throw new Error("治理视图没有返回数据");
  return payload.data;
}

function shortDigest(value?: string) { return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "未固化"; }
function statusLabel(value: string) {
  const labels: Record<string, string> = { approved: "已批准", pending: "待审核", revoked: "已撤销", passed: "扫描通过", failed: "扫描失败", open: "熔断中", closed: "正常", not_required: "无需扫描" };
  return labels[value] ?? value;
}
function statusTone(value: string) { return value === "approved" || value === "passed" || value === "closed" ? "good" : value === "revoked" || value === "failed" || value === "open" ? "danger" : "wait"; }

export function PiGovernanceConsole({ onNotice }: { onNotice: (message: string) => void }) {
  const [snapshot, setSnapshot] = useState<GovernanceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setSnapshot(await readApi<GovernanceSnapshot>("/api/v1/pi/admin/overview")); }
    catch (reason) { setSnapshot(null); setError(reason instanceof Error ? reason.message : "治理视图读取失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let active = true;
    void readApi<GovernanceSnapshot>("/api/v1/pi/admin/overview").then((data) => {
      if (!active) return;
      setSnapshot(data);
      setError("");
      setLoading(false);
    }).catch((reason) => {
      if (!active) return;
      setSnapshot(null);
      setError(reason instanceof Error ? reason.message : "治理视图读取失败");
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const mutate = useCallback(async (key: string, url: string, body?: unknown) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || "治理动作未完成");
      onNotice("治理动作已写入控制面，视图正在刷新");
      await load();
    } catch (reason) { onNotice(reason instanceof Error ? reason.message : "治理动作失败"); }
    finally { setBusyKey(""); }
  }, [busyKey, load, onNotice]);

  const resourceCount = useMemo(() => (snapshot?.resources.skills.length ?? 0) + (snapshot?.resources.artifacts.length ?? 0), [snapshot]);
  if (loading && !snapshot) return <GovernanceState icon={RefreshCw} title="正在读取 Agent 治理快照" detail="只读取当前租户授权范围内的 Profile、资源和 MCP capability。" spinning />;
  if (!snapshot) return <GovernanceState icon={LockKeyhole} title="治理控制面不可用" detail={error || "没有取得治理能力快照；不会填充预置记录。"} action="重新读取" onAction={() => void load()} tone="danger" />;

  return <div className="pi-governance-view">
    <header className="pi-governance-head">
      <div><p className="eyebrow">PI GOVERNANCE / CAPABILITY CONTROL</p><h1>Agent 能力治理</h1><p>只在服务端已授权、已签名、已固化的范围内查看和变更 Profile、Skill、Package、Extension 与 MCP。</p></div>
      <button className="pi-ghost-button" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} />刷新快照</button>
    </header>
    <section className="pi-governance-safety"><ShieldCheck size={16} /><span><strong>安全边界</strong> 页面不接触 Secret、签名原文、MCP endpoint 或执行凭据；所有治理动作仍由 API 权限、摘要、版本和审计门禁决定。</span><span className="pi-governance-digest"><Fingerprint size={13} />服务端快照</span></section>
    <section className="pi-governance-metrics" aria-label="治理能力概览">
      <Metric icon={SlidersHorizontal} label="Profiles" value={snapshot.profiles.length} note={snapshot.capabilities.canManageProfiles ? "可查看当前版本" : "仅可查看"} />
      <Metric icon={Sparkles} label="资源发布" value={resourceCount} note={snapshot.capabilities.canApproveRegistry ? "审核能力已授权" : "审核能力未授权"} />
      <Metric icon={ServerCog} label="MCP Server" value={snapshot.mcp.servers.length} note={snapshot.capabilities.canManageMcp ? "管理能力已授权" : "只读/不可见"} />
      <Metric icon={TerminalSquare} label="Tool Binding" value={snapshot.mcp.bindings.length} note="按租户范围过滤" />
    </section>

    <div className="pi-governance-grid">
      <section className="pi-governance-panel pi-governance-wide"><PanelHead icon={SlidersHorizontal} title="Profile 发布快照" meta={`${snapshot.profiles.length} 个当前有效版本`} /><div className="pi-profile-list">{snapshot.profiles.map((profile) => <article key={profile.id} className="pi-profile-card"><div className="pi-card-title"><div><span className="pi-kicker">{profile.id.toUpperCase()} · v{profile.version}</span><strong>{profile.description}</strong></div><StatusBadge value={`R${profile.maxRiskLevel.replace("R", "")}`} tone={profile.maxRiskLevel === "R4" ? "danger" : "wait"} /></div><div className="pi-profile-facts"><span>能力 <b>{profile.allowedTools.length} tools</b></span><span>网络 <b>{profile.networkPolicy}</b></span><span>工作区 <b>{profile.canModifyWorkspace ? "可修改" : "只读"}</b></span><span>沙盒 <b>{profile.canExecuteSandbox ? "可执行" : "关闭"}</b></span></div><div className="pi-digest-line"><Fingerprint size={12} />{shortDigest(profile.digest)}<span>子 Agent 深度 {profile.delegationPolicy.maxDepth} · 子预算 {profile.delegationPolicy.budget.maxTokens.toLocaleString()} tokens</span></div></article>)}</div><div className="pi-locked-note"><LockKeyhole size={14} /><span>Profile 编辑、升权和发布需要独立 `pi:profile:admin` API；当前页面不会通过前端直接改变运行快照。</span></div></section>

      <section className="pi-governance-panel"><PanelHead icon={Sparkles} title="Skill / Package / Extension" meta={`${resourceCount} 个租户资源`} />{!snapshot.capabilities.canReadRegistry ? <EmptyGovernance title="资源目录未授权" detail="当前主体没有 pi:registry:read。" /> : resourceCount === 0 ? <EmptyGovernance title="没有资源发布记录" detail="不会生成演示 Skill 或制品。可通过已授权发布 API 接入。" /> : <div className="pi-release-list">{[...snapshot.resources.skills.map((item) => ({ ...item, resourceKey: item.skillId, kind: "skill" as const })), ...snapshot.resources.artifacts.map((item) => ({ ...item, resourceKey: item.resourceId, kind: item.kind }))].map((item) => <article key={`${item.kind}:${item.resourceKey}:${item.version}`}><div className="pi-release-main"><span className="pi-kicker">{item.kind.toUpperCase()} · {item.version}</span><strong>{item.resourceKey}</strong><small>{shortDigest(item.digest)} · {item.allowedProfiles.join(", ") || "无 Profile"}</small></div><div className="pi-release-side"><StatusBadge value={statusLabel(item.approvalStatus)} tone={statusTone(item.approvalStatus)} />{"scanStatus" in item ? <StatusBadge value={statusLabel(item.scanStatus)} tone={statusTone(item.scanStatus)} /> : null}<small>{item.rolloutPercent}% 灰度</small></div><div className="pi-release-actions">{snapshot.capabilities.canApproveRegistry && item.approvalStatus === "pending" ? <button disabled={busyKey !== ""} onClick={() => void mutate(`approve:${item.kind}:${item.resourceKey}`, `/api/v1/pi/admin/resources/${item.kind}/${encodeURIComponent(item.resourceKey)}/${encodeURIComponent(item.version)}/approve`)}>批准</button> : null}{snapshot.capabilities.canApproveRegistry && item.approvalStatus === "approved" ? <button disabled={busyKey !== ""} onClick={() => void mutate(`rollout:${item.kind}:${item.resourceKey}`, `/api/v1/pi/admin/resources/${item.kind}/${encodeURIComponent(item.resourceKey)}/${encodeURIComponent(item.version)}/rollout`, { percent: 100 })}>全量灰度</button> : null}{snapshot.capabilities.canApproveRegistry && item.approvalStatus !== "revoked" ? <button className="is-danger" disabled={busyKey !== ""} onClick={() => void mutate(`revoke:${item.kind}:${item.resourceKey}`, `/api/v1/pi/admin/resources/${item.kind}/${encodeURIComponent(item.resourceKey)}/${encodeURIComponent(item.version)}/revoke`)}>撤销</button> : null}</div></article>)}</div>}</section>

      <section className="pi-governance-panel"><PanelHead icon={ServerCog} title="MCP Server 与 Binding" meta={`${snapshot.mcp.servers.length} Server · ${snapshot.mcp.bindings.length} Binding`} />{!snapshot.capabilities.canManageMcp ? <EmptyGovernance title="MCP 管理能力未授权" detail="当前主体不会看到 Server endpoint、凭据引用或未授权 Binding。" /> : snapshot.mcp.servers.length === 0 ? <EmptyGovernance title="没有 MCP Server 记录" detail="注册、探测、Schema 固化、批准和撤销必须通过受控 API。" /> : <div className="pi-mcp-list">{snapshot.mcp.servers.map((server) => <article key={`${server.id}:${server.version}`}><div className="pi-mcp-main"><span className="pi-kicker">{server.id} · {server.version}</span><strong>{server.source}</strong><small>{shortDigest(server.digest)} · {server.toolCount} tools · {server.schemaDigest ? `Schema ${shortDigest(server.schemaDigest)}` : "Schema 未固化"}</small></div><div className="pi-release-side"><StatusBadge value={statusLabel(server.approvalStatus)} tone={statusTone(server.approvalStatus)} /><StatusBadge value={statusLabel(server.circuitState)} tone={statusTone(server.circuitState)} /></div><div className="pi-release-actions">{server.approvalStatus !== "revoked" ? <button className="is-danger" disabled={busyKey !== ""} onClick={() => void mutate(`mcp-revoke:${server.id}`, `/api/v1/pi/admin/mcp-servers/${encodeURIComponent(server.id)}/revoke`, { version: server.version })}>撤销 Server</button> : null}<small>失败 {server.failureCount} 次 · {server.probedAt ? "已探测" : "未探测"}</small></div></article>)}</div>}</section>

      <section className="pi-governance-panel"><PanelHead icon={Database} title="Tool Binding 影响范围" meta="只显示已脱敏摘要" />{snapshot.mcp.bindings.length === 0 ? <EmptyGovernance title="没有 Binding" detail="Binding 必须绑定已批准且 Schema 固化的 Server Tool。" /> : <div className="pi-binding-list">{snapshot.mcp.bindings.map((binding) => <article key={binding.id}><div><span className="pi-kicker">{binding.exposedName}</span><strong>{binding.serverId} / {binding.toolName}</strong><small>{binding.allowedProfiles.join(", ")} · {binding.scope.type} · {binding.dataClassification}</small></div><div><StatusBadge value={statusLabel(binding.status)} tone={statusTone(binding.status)} />{binding.status === "approved" ? <button className="pi-inline-danger" disabled={busyKey !== ""} onClick={() => void mutate(`binding-revoke:${binding.id}`, `/api/v1/pi/admin/mcp-bindings/${binding.id}/revoke`)}>撤销</button> : null}</div></article>)}</div>}</section>
    </div>
    <footer className="pi-governance-footer"><CircleDashed size={14} /><span>治理快照由服务端按 tenant / actor / permission 重算；审计记录保留，撤销不会删除历史事实。</span><span><Clock3 size={13} />本地 UI 不代表 G-033 或生产 Gate 已通过</span></footer>
  </div>;
}

function Metric({ icon: Icon, label, value, note }: { icon: typeof Database; label: string; value: number; note: string }) { return <div className="pi-governance-metric"><Icon size={16} /><span>{label}</span><strong>{value}</strong><small>{note}</small></div>; }
function PanelHead({ icon: Icon, title, meta }: { icon: typeof Database; title: string; meta: string }) { return <header className="pi-governance-panel-head"><div><span><Icon size={15} />{title}</span><small>{meta}</small></div><ChevronRight size={14} /></header>; }
function StatusBadge({ value, tone }: { value: string; tone: string }) { return <span className={`pi-status-badge is-${tone}`}><i />{value}</span>; }
function EmptyGovernance({ title, detail }: { title: string; detail: string }) { return <div className="pi-governance-empty"><CircleOff size={22} /><strong>{title}</strong><span>{detail}</span></div>; }
function GovernanceState({ icon: Icon, title, detail, action, onAction, spinning = false, tone = "neutral" }: { icon: typeof LockKeyhole; title: string; detail: string; action?: string; onAction?: () => void; spinning?: boolean; tone?: "neutral" | "danger" }) { return <div className={`pi-governance-state is-${tone}`}><Icon className={spinning ? "spin" : ""} size={25} /><strong>{title}</strong><p>{detail}</p>{action && onAction ? <button onClick={onAction}>{action}<ChevronRight size={14} /></button> : null}</div>; }
