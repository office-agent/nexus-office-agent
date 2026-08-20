import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { stableJson } from "@/src/modules/pi-agent/application/manifest";
import type {
  PiCapacityAdmission,
  PiCapacityLease,
  PiCapacityPolicy,
  PiCapacityPolicyDraft,
  PiFaultPlan,
  PiFaultPlanDraft,
  PiFaultTarget,
  PiKillSwitch,
  PiKillSwitchDraft,
  PiResilienceSnapshot,
  PiSecurityEvent,
  PiSecurityEventInput,
  PiSecurityResilienceStore,
  PiUntrustedContentResult,
} from "@/src/modules/pi-agent/domain/security-resilience-contracts";

type ExecutionSubject = {
  profile?: string;
  modelRouteId?: string;
  resourceDigest?: string;
};

type UntrustedSource = PiUntrustedContentResult["source"];

const SIGNALS: Array<{ code: string; pattern: RegExp }> = [
  { code: "instruction_override", pattern: /ignore\s+(all\s+)?previous\s+instructions|忽略(?:以上|之前|所有)指令/iu },
  { code: "secret_exfiltration", pattern: /(?:print|read|send|exfiltrat|泄露|导出|读取).{0,40}(?:secret|token|password|密钥|令牌|密码)/iu },
  { code: "privilege_bypass", pattern: /(?:bypass|circumvent|disable|绕过|关闭|跳过).{0,40}(?:permission|approval|policy|权限|确认|策略)/iu },
  { code: "tool_impersonation", pattern: /(?:call|invoke|run|execute|调用|执行).{0,40}(?:admin|shell|sudo|tool|工具)/iu },
];

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertText(value: string, code: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(code);
  return normalized;
}

function assertDigest(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function assertPositiveInteger(value: number, code: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(code);
  return value;
}

function assertSystemOrPermission(context: RequestContext, permission: string): void {
  assertPiPermission(context, permission);
}

function matches(subject: ExecutionSubject, item: PiKillSwitch): boolean {
  if (item.status !== "active") return false;
  if (item.scope === "global") return true;
  if (item.scope === "tenant") return true;
  if (item.scope === "profile") return Boolean(subject.profile && subject.profile === item.targetProfile);
  if (item.scope === "model") return Boolean(subject.modelRouteId && subject.modelRouteId === item.targetModelRouteId);
  return Boolean(subject.resourceDigest && subject.resourceDigest === item.targetDigest);
}

function killSwitchError(item: PiKillSwitch): Error {
  const error = new Error("PI_KILL_SWITCH_ACTIVE");
  error.cause = { scope: item.scope, reasonCode: item.reasonCode };
  return error;
}

export class PiSecurityResilienceService {
  private readonly allowFaultInjection: boolean;

  constructor(
    private readonly store: PiSecurityResilienceStore,
    options: { allowFaultInjection?: boolean } = {},
  ) {
    this.allowFaultInjection = options.allowFaultInjection ?? process.env.NODE_ENV !== "production";
  }

  async activateKillSwitch(context: RequestContext, draft: PiKillSwitchDraft): Promise<PiKillSwitch> {
    assertSystemOrPermission(context, "pi:kill-switch:write");
    const scope = draft.scope;
    if (!(["global", "tenant", "profile", "model", "resource"] as const).includes(scope)) throw new Error("PI_KILL_SWITCH_SCOPE_INVALID");
    if (scope === "global") assertSystemOrPermission(context, "pi:kill-switch:global");
    if (scope === "profile" && !draft.targetProfile) throw new Error("PI_KILL_SWITCH_TARGET_REQUIRED");
    if (scope === "model" && !draft.targetModelRouteId) throw new Error("PI_KILL_SWITCH_TARGET_REQUIRED");
    if (scope === "resource" && !draft.targetDigest) throw new Error("PI_KILL_SWITCH_TARGET_REQUIRED");
    if (scope === "tenant" && (draft.targetProfile || draft.targetModelRouteId || draft.targetDigest)) throw new Error("PI_KILL_SWITCH_TARGET_INVALID");
    const reasonCode = assertText(draft.reasonCode, "PI_KILL_SWITCH_REASON_INVALID", 128);
    const item: PiKillSwitch = {
      id: randomUUID(),
      tenantId: context.tenantId,
      scope,
      ...(draft.targetDigest ? { targetDigest: assertDigest(draft.targetDigest, "PI_KILL_SWITCH_DIGEST_INVALID") } : {}),
      ...(draft.targetProfile ? { targetProfile: assertText(draft.targetProfile, "PI_KILL_SWITCH_PROFILE_INVALID", 64) } : {}),
      ...(draft.targetModelRouteId ? { targetModelRouteId: assertText(draft.targetModelRouteId, "PI_KILL_SWITCH_MODEL_INVALID", 256) } : {}),
      reasonCode,
      status: "active",
      activatedBy: context.actorId,
      activatedAt: new Date().toISOString(),
      version: 1,
      actionDigest: digest({ scope, tenantId: context.tenantId, reasonCode, targetDigest: draft.targetDigest, targetProfile: draft.targetProfile, targetModelRouteId: draft.targetModelRouteId }),
    };
    const existing = await this.store.findKillSwitchByActionDigest(context, item.actionDigest);
    if (existing) return existing;
    await this.store.putKillSwitch(item);
    await this.recordSecurityEvent(context, { kind: "kill_switch_activated", severity: "P0", subjectDigest: item.actionDigest, reasonCode });
    return item;
  }

  async releaseKillSwitch(context: RequestContext, id: string): Promise<PiKillSwitch> {
    assertSystemOrPermission(context, "pi:kill-switch:write");
    const item = await this.store.releaseKillSwitch(context, assertText(id, "PI_KILL_SWITCH_ID_INVALID"), new Date().toISOString(), context.actorId);
    await this.recordSecurityEvent(context, { kind: "kill_switch_released", severity: "P1", subjectDigest: item.actionDigest, reasonCode: "ADMIN_RELEASE" });
    return item;
  }

  async listKillSwitches(context: RequestContext): Promise<PiKillSwitch[]> {
    assertSystemOrPermission(context, "pi:kill-switch:read");
    return this.store.listKillSwitches(context);
  }

  async listSecurityEvents(context: RequestContext, limit = 100) {
    assertSystemOrPermission(context, "pi:security:read");
    return this.store.listSecurityEvents(context, Math.min(Math.max(limit, 1), 1000));
  }

  async assertExecutionAllowed(context: RequestContext, subject: ExecutionSubject = {}): Promise<void> {
    const active = await this.store.listActiveKillSwitches(context);
    const matched = active.find((item) => matches(subject, item));
    if (!matched) return;
    await this.recordSecurityEvent(context, { kind: "kill_switch_activated", severity: "P0", subjectDigest: matched.actionDigest, reasonCode: matched.reasonCode });
    throw killSwitchError(matched);
  }

  async recordSecurityEvent(context: RequestContext, input: PiSecurityEventInput): Promise<PiSecurityEvent> {
    const event: PiSecurityEvent = {
      id: randomUUID(),
      tenantId: context.tenantId,
      actorId: context.actorId,
      kind: input.kind,
      severity: input.severity,
      subjectDigest: assertDigest(input.subjectDigest, "PI_SECURITY_SUBJECT_DIGEST_INVALID") ?? digest(input.subjectDigest),
      reasonCode: assertText(input.reasonCode, "PI_SECURITY_REASON_INVALID", 128),
      policyVersion: input.policyVersion ?? 1,
      traceId: context.traceId,
      createdAt: new Date().toISOString(),
    };
    await this.store.appendSecurityEvent(event);
    return event;
  }

  inspectUntrustedContent(source: UntrustedSource, content: string): PiUntrustedContentResult {
    if (!(["prompt", "repository", "document", "tool_result"] as const).includes(source)) throw new Error("PI_UNTRUSTED_SOURCE_INVALID");
    const bounded = content.slice(0, 64_000);
    const matchedSignals = SIGNALS.filter(({ pattern }) => pattern.test(bounded)).map(({ code }) => code);
    const sanitized = SIGNALS.reduce((value, { pattern }) => value.replace(pattern, "[untrusted_instruction_removed]"), bounded);
    return {
      trust: "untrusted",
      source,
      contentDigest: digest({ source, content: bounded }),
      injectionDetected: matchedSignals.length > 0,
      matchedSignals,
      safeEnvelope: `<untrusted_${source}_context digest="${digest({ source, content: bounded })}">\n${sanitized}\n</untrusted_${source}_context>`,
    };
  }

  async inspectAndRecordUntrustedContent(context: RequestContext, source: UntrustedSource, content: string): Promise<PiUntrustedContentResult> {
    const result = this.inspectUntrustedContent(source, content);
    if (result.injectionDetected) {
      await this.recordSecurityEvent(context, {
        kind: source === "repository" ? "malicious_repository_context" : "prompt_injection_detected",
        severity: "P1",
        subjectDigest: result.contentDigest,
        reasonCode: result.matchedSignals.join("+") || "UNTRUSTED_CONTENT",
      });
    }
    return result;
  }

  async publishCapacityPolicy(context: RequestContext, draft: PiCapacityPolicyDraft): Promise<PiCapacityPolicy> {
    assertSystemOrPermission(context, "pi:capacity:admin");
    if (draft.scope === "profile" && !draft.scopeId) throw new Error("PI_CAPACITY_SCOPE_ID_REQUIRED");
    if (draft.scope === "tenant" && draft.scopeId) throw new Error("PI_CAPACITY_SCOPE_ID_INVALID");
    const policy: PiCapacityPolicy = {
      id: randomUUID(), tenantId: context.tenantId, scope: draft.scope, ...(draft.scopeId ? { scopeId: assertText(draft.scopeId, "PI_CAPACITY_SCOPE_ID_INVALID", 128) } : {}),
      version: assertPositiveInteger(draft.version, "PI_CAPACITY_VERSION_INVALID", 100_000),
      maxConcurrentRuns: assertPositiveInteger(draft.maxConcurrentRuns, "PI_CAPACITY_LIMIT_INVALID", 100_000),
      maxQueueDepth: assertPositiveInteger(draft.maxQueueDepth, "PI_CAPACITY_LIMIT_INVALID", 1_000_000),
      maxPromptBytes: assertPositiveInteger(draft.maxPromptBytes, "PI_CAPACITY_LIMIT_INVALID", 16_777_216),
      maxEventBytes: assertPositiveInteger(draft.maxEventBytes, "PI_CAPACITY_LIMIT_INVALID", 16_777_216),
      status: "active",
      createdAt: new Date().toISOString(),
    };
    await this.store.putCapacityPolicy(policy);
    return policy;
  }

  async listCapacityPolicies(context: RequestContext): Promise<PiCapacityPolicy[]> {
    assertSystemOrPermission(context, "pi:capacity:read");
    return this.store.listCapacityPolicies(context);
  }

  async admitCapacity(context: RequestContext, input: { runId: string; idempotencyKey: string; profile?: string }): Promise<PiCapacityAdmission> {
    const runId = assertText(input.runId, "PI_RUN_ID_INVALID", 256);
    const idempotencyKey = assertText(input.idempotencyKey, "PI_IDEMPOTENCY_KEY_INVALID", 256);
    const policy = (input.profile ? await this.store.findCapacityPolicy(context, "profile", input.profile) : null) ?? await this.store.findCapacityPolicy(context, "tenant");
    if (!policy || policy.status !== "active") throw new Error("PI_CAPACITY_NOT_READY");
    const existing = await this.store.findCapacityLeaseByIdempotency(context, idempotencyKey);
    if (existing) {
      if (existing.status !== "active") throw new Error("PI_CAPACITY_IDEMPOTENCY_CONFLICT");
      return { allowed: true, policy, active: await this.store.countActiveCapacity(context, policy.id), leaseId: existing.id };
    }
    const active = await this.store.countActiveCapacity(context, policy.id);
    if (active >= policy.maxConcurrentRuns) {
      await this.recordSecurityEvent(context, { kind: "capacity_rejected", severity: "P1", subjectDigest: digest({ runId, policyId: policy.id }), reasonCode: "PI_CAPACITY_EXCEEDED" });
      return { allowed: false, policy, active, reasonCode: "PI_CAPACITY_EXCEEDED" };
    }
    const lease: PiCapacityLease = { id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, runId, scope: policy.scope, ...(policy.scopeId ? { scopeId: policy.scopeId } : {}), policyId: policy.id, policyVersion: policy.version, idempotencyKey, status: "active", acquiredAt: new Date().toISOString() };
    const result = await this.store.acquireCapacity(lease);
    return { allowed: true, policy, active: result.created ? active + 1 : active, leaseId: result.lease.id };
  }

  async releaseCapacity(context: RequestContext, leaseId: string): Promise<PiCapacityLease> {
    assertSystemOrPermission(context, "pi:capacity:write");
    return this.store.releaseCapacity(context, assertText(leaseId, "PI_CAPACITY_LEASE_ID_INVALID"), new Date().toISOString());
  }

  async configureFault(context: RequestContext, draft: PiFaultPlanDraft): Promise<PiFaultPlan> {
    assertSystemOrPermission(context, "pi:failure:inject");
    if (!this.allowFaultInjection) throw new Error("PI_FAULT_INJECTION_DISABLED");
    if (!Number.isInteger(draft.remaining) || draft.remaining < 1 || draft.remaining > 100) throw new Error("PI_FAULT_REMAINING_INVALID");
    if (!Number.isInteger(draft.ttlSeconds) || draft.ttlSeconds < 1 || draft.ttlSeconds > 3600) throw new Error("PI_FAULT_TTL_INVALID");
    const plan: PiFaultPlan = { id: randomUUID(), tenantId: context.tenantId, target: draft.target, errorCode: assertText(draft.errorCode, "PI_FAULT_CODE_INVALID", 128), remaining: draft.remaining, createdBy: context.actorId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + draft.ttlSeconds * 1000).toISOString() };
    await this.store.putFaultPlan(plan);
    return plan;
  }

  async consumeFault(context: RequestContext, target: PiFaultTarget): Promise<void> {
    if (!this.allowFaultInjection) return;
    const plan = await this.store.getFaultPlan(context, target);
    if (!plan || new Date(plan.expiresAt) <= new Date() || plan.remaining <= 0) return;
    const next = { ...plan, remaining: plan.remaining - 1 };
    await this.store.putFaultPlan(next);
    await this.recordSecurityEvent(context, { kind: "fault_injected", severity: "P1", subjectDigest: digest({ target, planId: plan.id }), reasonCode: plan.errorCode });
    throw new Error(plan.errorCode);
  }

  async clearFaults(context: RequestContext): Promise<void> {
    assertSystemOrPermission(context, "pi:failure:inject");
    if (!this.allowFaultInjection) throw new Error("PI_FAULT_INJECTION_DISABLED");
    await this.store.clearFaultPlans(context);
  }

  async snapshot(context: RequestContext): Promise<PiResilienceSnapshot> {
    const [killSwitches, events, policies] = await Promise.all([this.store.listKillSwitches(context), this.store.listSecurityEvents(context, 1000), this.store.listCapacityPolicies(context)]);
    const capacity = await Promise.all(policies.filter((policy) => policy.status === "active").map(async (policy) => ({ policy, active: await this.store.countActiveCapacity(context, policy.id) })));
    return {
      killSwitches: killSwitches.map((item) => ({ ...item })),
      securityEvents: { total: events.length, highSeverity: events.filter((event) => event.severity === "P0" || event.severity === "P1").length, ...(events[0] ? { latestAt: events[0].createdAt } : {}) },
      capacity,
      faultsEnabled: this.allowFaultInjection,
      generatedAt: new Date().toISOString(),
    };
  }
}
