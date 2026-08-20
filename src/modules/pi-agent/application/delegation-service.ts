import { randomUUID } from "node:crypto";
import type { RequestContext, DataScope } from "@/src/platform/context/request-context";
import type { PiSession, PiSessionStore } from "@/src/modules/pi-agent/domain/contracts";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { sha256, stableJson } from "@/src/modules/pi-agent/application/manifest";
import type { AgentProfileRegistry, PiAgentProfileSnapshot, PiDelegationBudget } from "@/src/modules/pi-agent/domain/profile-contracts";
import type { PiChildResult, PiDelegation, PiDelegationAdmission, PiDelegationRequest, PiChildSessionFactory, PiDelegationStore } from "@/src/modules/pi-agent/domain/delegation-contracts";

const ACTIVE_STATUSES = ["admitted", "queued", "running"] as const;
const TERMINAL_SESSION_STATUSES = ["succeeded", "failed", "timed_out", "cancelled", "unknown"] as const;

function clone<T>(value: T): T { return structuredClone(value); }
function now(): string { return new Date().toISOString(); }
function riskRank(value: string): number { return Number(value.slice(1)); }
function idempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 256) throw new Error("PI_IDEMPOTENCY_KEY_REQUIRED");
  return key;
}

function networkRank(value: PiAgentProfileSnapshot["networkPolicy"]): number {
  return value === "none" ? 0 : value === "allowlist" ? 1 : 2;
}

function scopeKey(scope: DataScope): string { return stableJson(scope); }

function intersectScopes(parent: DataScope[], child: DataScope[]): DataScope[] {
  const result: DataScope[] = [];
  for (const left of parent) {
    for (const right of child) {
      if (left.type === "tenant") result.push(clone(right));
      else if (right.type === "tenant") result.push(clone(left));
      else if (left.type === "self" && right.type === "self") result.push({ type: "self" });
      else if (left.type === "owned" && right.type === "owned") result.push({ type: "owned" });
      else if (left.type === "team" && right.type === "team") {
        const teamIds = left.teamIds.filter((id) => right.teamIds.includes(id));
        if (teamIds.length) result.push({ type: "team", teamIds: teamIds.sort() });
      } else if (left.type === "project" && right.type === "project") {
        const projectIds = left.projectIds.filter((id) => right.projectIds.includes(id));
        if (projectIds.length) result.push({ type: "project", projectIds: projectIds.sort() });
      } else if (left.type === "explicit" && right.type === "explicit") {
        const resourceIds = left.resourceIds.filter((id) => right.resourceIds.includes(id));
        if (resourceIds.length) result.push({ type: "explicit", resourceIds: resourceIds.sort() });
      } else if (left.type === "org_subtree" && right.type === "org_subtree") {
        const orgUnitIds = left.orgUnitIds.filter((id) => right.orgUnitIds.includes(id));
        if (orgUnitIds.length) result.push({ type: "org_subtree", orgUnitIds: orgUnitIds.sort() });
      }
    }
  }
  return [...new Map(result.map((scope) => [scopeKey(scope), scope])).values()];
}

function intersectBudget(parent: PiDelegationBudget, child: PiDelegationBudget, requested?: Partial<PiDelegationBudget>): PiDelegationBudget {
  const ceiling: PiDelegationBudget = {
    maxDurationMs: Math.min(parent.maxDurationMs, child.maxDurationMs),
    maxOutputBytes: Math.min(parent.maxOutputBytes, child.maxOutputBytes),
    maxTokens: Math.min(parent.maxTokens, child.maxTokens),
    maxChildRuns: Math.min(parent.maxChildRuns, child.maxChildRuns),
  };
  const result: PiDelegationBudget = {
    maxDurationMs: Number(requested?.maxDurationMs ?? ceiling.maxDurationMs),
    maxOutputBytes: Number(requested?.maxOutputBytes ?? ceiling.maxOutputBytes),
    maxTokens: Number(requested?.maxTokens ?? ceiling.maxTokens),
    maxChildRuns: Number(requested?.maxChildRuns ?? ceiling.maxChildRuns),
  };
  const invalid = Object.entries(result).some(([key, value]) => !Number.isSafeInteger(value) || value < 0 || value > ceiling[key as keyof PiDelegationBudget]);
  if (invalid || result.maxDurationMs < 1 || result.maxOutputBytes < 1 || result.maxTokens < 1) throw new Error("PI_DELEGATION_BUDGET_EXCEEDED");
  return result;
}

export class DelegationService {
  constructor(
    private readonly sessionStore: PiSessionStore,
    private readonly delegationStore: PiDelegationStore,
    private readonly profileRegistry: AgentProfileRegistry,
    private readonly childSessionFactory?: PiChildSessionFactory,
    private readonly executionEnabled = false,
  ) {}

  async validateDelegation(context: RequestContext, input: PiDelegationRequest): Promise<PiDelegationAdmission> {
    assertPiPermission(context, "pi:delegation:create");
    const parent = await this.requireSession(context, input.parentSessionId);
    const parentProfile = await this.profileRegistry.resolveProfile(context, parent.profile);
    const childProfile = await this.profileRegistry.resolveProfile(context, input.profile);
    if (!parentProfile.delegationPolicy.allowedProfiles.includes(childProfile.id)) throw new Error("PI_DELEGATION_PROFILE_NOT_ALLOWED");
    if (childProfile.allowedTools.some((tool) => !parentProfile.allowedTools.includes(tool))) throw new Error("PI_DELEGATION_TOOL_ESCALATION");
    if (riskRank(childProfile.maxRiskLevel) > riskRank(parentProfile.maxRiskLevel)) throw new Error("PI_DELEGATION_RISK_ESCALATION");
    if (networkRank(childProfile.networkPolicy) > networkRank(parentProfile.networkPolicy)) throw new Error("PI_DELEGATION_NETWORK_ESCALATION");
    if (childProfile.canModifyWorkspace && !parentProfile.canModifyWorkspace) throw new Error("PI_DELEGATION_WORKSPACE_ESCALATION");
    if (childProfile.canExecuteSandbox && !parentProfile.canExecuteSandbox) throw new Error("PI_DELEGATION_SANDBOX_ESCALATION");
    const ancestor = await this.delegationStore.getByChildSession(context, parent.id);
    const depth = (ancestor?.depth ?? 0) + 1;
    if (depth > parentProfile.delegationPolicy.maxDepth) throw new Error("PI_DELEGATION_DEPTH_EXCEEDED");
    const activeChildren = await this.delegationStore.countActiveByParent(context, parent.id);
    if (activeChildren >= parentProfile.delegationPolicy.maxConcurrentChildren) throw new Error("PI_DELEGATION_CONCURRENCY_EXCEEDED");
    const dataScopes = intersectScopes(ancestor?.dataScopes ?? context.dataScopes, childProfile.allowedDataScopes);
    if (dataScopes.length === 0) throw new Error("PI_DELEGATION_DATA_SCOPE_EMPTY");
    const budget = intersectBudget(ancestor?.budget ?? parentProfile.delegationPolicy.budget, childProfile.delegationPolicy.budget, input.budget);
    return { profile: childProfile, parentProfile, depth, budget, allowedTools: parentProfile.allowedTools.filter((tool) => childProfile.allowedTools.includes(tool)).sort(), dataScopes };
  }

  async propose(context: RequestContext, input: PiDelegationRequest): Promise<{ delegation: PiDelegation; admission: PiDelegationAdmission; created: boolean }> {
    const key = idempotencyKey(input.idempotencyKey);
    const existing = await this.delegationStore.findByIdempotency(context, input.parentSessionId, key);
    if (existing) {
      const admission = await this.validateDelegation(context, input);
      return { delegation: existing, admission, created: false };
    }
    const admission = await this.validateDelegation(context, input);
    const record: PiDelegation = {
      id: randomUUID(),
      tenantId: context.tenantId,
      parentSessionId: input.parentSessionId,
      parentBranchId: input.parentBranchId,
      profileId: admission.profile.id,
      profileVersion: admission.profile.version,
      profileDigest: admission.profile.digest,
      depth: admission.depth,
      status: "proposed",
      budget: admission.budget,
      allowedTools: admission.allowedTools,
      dataScopes: admission.dataScopes,
      idempotencyKey: key,
      version: 1,
      createdBy: context.actorId,
      createdAt: now(),
      updatedAt: now(),
    };
    const created = await this.delegationStore.create(record);
    await this.appendEvent(context, input.parentSessionId, "pi.child.queued", { delegationId: created.id, profile: created.profileId, profileDigest: created.profileDigest, depth: created.depth, budget: created.budget, allowedToolCount: created.allowedTools.length });
    return { delegation: created, admission, created: true };
  }

  async allocateChildBudget(context: RequestContext, input: PiDelegationRequest): Promise<PiDelegationBudget> {
    return (await this.validateDelegation(context, input)).budget;
  }

  async spawnChildRun(context: RequestContext, input: PiDelegationRequest): Promise<PiDelegation> {
    if (!this.executionEnabled || !this.childSessionFactory) throw new Error("PI_DELEGATION_EXECUTION_DISABLED");
    const proposal = await this.propose(context, input);
    if (proposal.delegation.childSessionId) return proposal.delegation;
    const admitted = await this.delegationStore.update(context, proposal.delegation.id, proposal.delegation.version, { status: "admitted" });
    try {
      const parent = await this.requireSession(context, input.parentSessionId);
      const child = await this.childSessionFactory.createChildSession(context, parent, proposal.admission, admitted.id);
      const queued = await this.delegationStore.update(context, admitted.id, admitted.version, { childSessionId: child.id, status: "queued" });
      await this.appendEvent(context, input.parentSessionId, "pi.child.queued", { delegationId: queued.id, childSessionId: child.id, depth: queued.depth, profileDigest: queued.profileDigest });
      await this.appendEvent(context, child.id, "pi.child.queued", { delegationId: queued.id, parentSessionId: input.parentSessionId, depth: queued.depth, profileDigest: queued.profileDigest });
      return queued;
    } catch (error) {
      await this.delegationStore.update(context, admitted.id, admitted.version, { status: "failed" }).catch(() => undefined);
      throw error;
    }
  }

  async cancelChildren(context: RequestContext, parentSessionId: string, reason = "parent_cancelled"): Promise<PiDelegation[]> {
    assertPiPermission(context, "pi:delegation:cancel");
    const children = await this.delegationStore.listByParent(context, parentSessionId);
    const cancelled: PiDelegation[] = [];
    for (const child of children.filter((item) => (ACTIVE_STATUSES as readonly string[]).includes(item.status))) {
      const updated = await this.delegationStore.update(context, child.id, child.version, { status: "cancelled" });
      if (updated.childSessionId) await this.sessionStore.updateSession(context, updated.childSessionId, { status: "cancelled", updatedAt: now() }).catch(() => undefined);
      await this.appendEvent(context, parentSessionId, "pi.child.terminal", { delegationId: updated.id, childSessionId: updated.childSessionId ?? null, status: "cancelled", reason: reason.slice(0, 200) });
      cancelled.push(updated);
    }
    return cancelled;
  }

  async collectChildResults(context: RequestContext, delegationId: string): Promise<PiChildResult> {
    assertPiPermission(context, "pi:session:read");
    const delegation = await this.delegationStore.get(context, delegationId);
    if (!delegation) throw new Error("PI_DELEGATION_NOT_FOUND");
    if (!delegation.childSessionId) return { delegation, eventCount: 0, latestEventSequence: 0, resultDigest: sha256(stableJson({ delegationId, childSessionId: null })), terminal: false };
    const childSession = await this.sessionStore.getSession(context, delegation.childSessionId);
    if (!childSession) throw new Error("PI_CHILD_SESSION_NOT_FOUND");
    const events = await this.sessionStore.getEvents(context, childSession.id, 0, 500);
    const checkpoints = await this.sessionStore.listCheckpoints(context, childSession.id);
    const resultDigest = sha256(stableJson({ delegationId, childSessionId: childSession.id, events: events.map((event) => ({ id: event.id, sequence: event.sequence, type: event.type })), checkpoints: checkpoints.map((checkpoint) => ({ id: checkpoint.id, diffDigest: checkpoint.diffDigest, gitCommitSha: checkpoint.gitCommitSha ?? null })) }));
    const terminal = (TERMINAL_SESSION_STATUSES as readonly string[]).includes(childSession.status);
    if (terminal && delegation.status !== "completed" && delegation.status !== "failed" && delegation.status !== "cancelled") await this.delegationStore.update(context, delegation.id, delegation.version, { status: childSession.status === "succeeded" ? "completed" : "failed" }).catch(() => undefined);
    return { delegation, childSession, eventCount: events.length, latestEventSequence: events.at(-1)?.sequence ?? 0, resultDigest, terminal };
  }

  async detectCycle(context: RequestContext, sessionId: string): Promise<boolean> {
    const visited = new Set<string>();
    let current = sessionId;
    while (true) {
      if (visited.has(current)) return true;
      visited.add(current);
      const link = await this.delegationStore.getByChildSession(context, current);
      if (!link) return false;
      current = link.parentSessionId;
    }
  }

  private async requireSession(context: RequestContext, sessionId: string): Promise<PiSession> {
    const session = await this.sessionStore.getSession(context, sessionId);
    if (!session) throw new Error("PI_SESSION_NOT_FOUND");
    return session;
  }

  private async appendEvent(context: RequestContext, sessionId: string, type: string, payload: unknown): Promise<void> {
    await this.sessionStore.appendEvent(context, sessionId, { type, payload, traceId: context.traceId });
  }
}

export class LocalPiChildSessionFactory implements PiChildSessionFactory {
  constructor(private readonly sessionStore: PiSessionStore) {}

  async createChildSession(context: RequestContext, parent: PiSession, admission: PiDelegationAdmission, delegationId: string): Promise<PiSession> {
    const timestamp = now();
    const child: PiSession = {
      ...clone(parent),
      id: randomUUID(),
      actorId: context.actorId,
      profile: admission.profile.id,
      profileVersion: admission.profile.version,
      status: "created",
      sandboxProfile: `${parent.sandboxProfile}:child`,
      networkPolicy: admission.profile.networkPolicy,
      mcpServerDigests: [],
      mcpBindingIds: [],
      mcpBindings: [],
      sandboxRunId: randomUUID(),
      traceId: context.traceId,
      lastEventSequence: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.sessionStore.createSession(child);
    await this.sessionStore.appendEvent(context, child.id, { type: "pi.child.queued", payload: { delegationId, parentSessionId: parent.id, profileId: admission.profile.id, profileDigest: admission.profile.digest, depth: admission.depth, allowedToolCount: admission.allowedTools.length }, traceId: context.traceId });
    return child;
  }
}
