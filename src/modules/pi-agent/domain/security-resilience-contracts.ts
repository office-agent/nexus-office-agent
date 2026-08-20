import type { RequestContext } from "@/src/platform/context/request-context";

export type PiKillSwitchScope = "global" | "tenant" | "profile" | "model" | "resource";
export type PiKillSwitchStatus = "active" | "released";
export type PiSecuritySeverity = "P0" | "P1" | "P2";
export type PiSecurityEventKind =
  | "cross_tenant_denied"
  | "prompt_injection_detected"
  | "malicious_repository_context"
  | "ssrf_denied"
  | "metadata_denied"
  | "sandbox_boundary_denied"
  | "resource_revoked"
  | "capacity_rejected"
  | "fault_injected"
  | "kill_switch_activated"
  | "kill_switch_released"
  | "dependency_failed"
  | "recovery_started"
  | "recovery_completed";

export type PiKillSwitch = {
  id: string;
  tenantId?: string;
  scope: PiKillSwitchScope;
  targetDigest?: string;
  targetProfile?: string;
  targetModelRouteId?: string;
  reasonCode: string;
  status: PiKillSwitchStatus;
  activatedBy: string;
  activatedAt: string;
  releasedAt?: string;
  releaseActorId?: string;
  version: number;
  actionDigest: string;
};

export type PiKillSwitchDraft = {
  scope: PiKillSwitchScope;
  targetDigest?: string;
  targetProfile?: string;
  targetModelRouteId?: string;
  reasonCode: string;
};

export type PiSecurityEvent = {
  id: string;
  tenantId: string;
  actorId?: string;
  kind: PiSecurityEventKind;
  severity: PiSecuritySeverity;
  subjectDigest: string;
  reasonCode: string;
  policyVersion: number;
  traceId: string;
  createdAt: string;
};

export type PiSecurityEventInput = {
  kind: PiSecurityEventKind;
  severity: PiSecuritySeverity;
  subjectDigest: string;
  reasonCode: string;
  policyVersion?: number;
};

export type PiCapacityScope = "tenant" | "profile";
export type PiCapacityPolicy = {
  id: string;
  tenantId: string;
  scope: PiCapacityScope;
  scopeId?: string;
  version: number;
  maxConcurrentRuns: number;
  maxQueueDepth: number;
  maxPromptBytes: number;
  maxEventBytes: number;
  status: "active" | "revoked";
  createdAt: string;
};

export type PiCapacityPolicyDraft = {
  scope: PiCapacityScope;
  scopeId?: string;
  version: number;
  maxConcurrentRuns: number;
  maxQueueDepth: number;
  maxPromptBytes: number;
  maxEventBytes: number;
};

export type PiCapacityLease = {
  id: string;
  tenantId: string;
  actorId: string;
  runId: string;
  scope: PiCapacityScope;
  scopeId?: string;
  policyId: string;
  policyVersion: number;
  idempotencyKey: string;
  status: "active" | "released";
  acquiredAt: string;
  releasedAt?: string;
};

export type PiFaultTarget = "queue.claim" | "runner.runtime" | "model.provider" | "telemetry.write" | "object.store" | "database.query";
export type PiFaultPlan = {
  id: string;
  tenantId: string;
  target: PiFaultTarget;
  errorCode: string;
  remaining: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
};

export type PiFaultPlanDraft = {
  target: PiFaultTarget;
  errorCode: string;
  remaining: number;
  ttlSeconds: number;
};

export type PiUntrustedContentResult = {
  trust: "untrusted";
  contentDigest: string;
  source: "prompt" | "repository" | "document" | "tool_result";
  injectionDetected: boolean;
  matchedSignals: string[];
  safeEnvelope: string;
};

export type PiResilienceSnapshot = {
  killSwitches: PiKillSwitch[];
  securityEvents: { total: number; highSeverity: number; latestAt?: string };
  capacity: Array<{ policy: PiCapacityPolicy; active: number }>;
  faultsEnabled: boolean;
  generatedAt: string;
};

export type PiCapacityAdmission = {
  allowed: boolean;
  policy: PiCapacityPolicy;
  active: number;
  leaseId?: string;
  reasonCode?: string;
};

export interface PiSecurityResilienceStore {
  listKillSwitches(context: RequestContext): Promise<PiKillSwitch[]>;
  listActiveKillSwitches(context: RequestContext): Promise<PiKillSwitch[]>;
  findKillSwitchByActionDigest(context: RequestContext, actionDigest: string): Promise<PiKillSwitch | null>;
  putKillSwitch(item: PiKillSwitch): Promise<void>;
  releaseKillSwitch(context: RequestContext, id: string, releasedAt: string, actorId: string): Promise<PiKillSwitch>;
  appendSecurityEvent(event: PiSecurityEvent): Promise<void>;
  listSecurityEvents(context: RequestContext, limit?: number): Promise<PiSecurityEvent[]>;
  putCapacityPolicy(policy: PiCapacityPolicy): Promise<void>;
  listCapacityPolicies(context: RequestContext): Promise<PiCapacityPolicy[]>;
  findCapacityPolicy(context: RequestContext, scope: PiCapacityScope, scopeId?: string): Promise<PiCapacityPolicy | null>;
  countActiveCapacity(context: RequestContext, policyId: string): Promise<number>;
  findCapacityLeaseByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiCapacityLease | null>;
  acquireCapacity(lease: PiCapacityLease): Promise<{ lease: PiCapacityLease; created: boolean }>;
  releaseCapacity(context: RequestContext, leaseId: string, releasedAt: string): Promise<PiCapacityLease>;
  getFaultPlan(context: RequestContext, target: PiFaultTarget): Promise<PiFaultPlan | null>;
  putFaultPlan(plan: PiFaultPlan): Promise<void>;
  clearFaultPlans(context: RequestContext): Promise<void>;
}
