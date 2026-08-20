import type { RequestContext } from "@/src/platform/context/request-context";

export type PiQuotaScope = "tenant" | "project" | "actor" | "profile";
export type PiQuotaReservationStatus = "active" | "released" | "consumed" | "exhausted";

export type PiQuotaPolicy = {
  id: string;
  tenantId: string;
  scope: PiQuotaScope;
  scopeId?: string;
  version: number;
  maxConcurrentRuns: number;
  maxTokens: number;
  maxCostMicros: number;
  maxStorageBytes: number;
  maxToolCalls: number;
  status: "active" | "revoked";
  createdAt: string;
};

export type PiQuotaUsage = {
  concurrentRuns: number;
  tokens: number;
  costMicros: number;
  storageBytes: number;
  toolCalls: number;
};

export type PiQuotaReservation = {
  id: string;
  tenantId: string;
  actorId: string;
  runId?: string;
  scope: PiQuotaScope;
  scopeId?: string;
  policyId: string;
  policyVersion: number;
  idempotencyKey: string;
  reserved: PiQuotaUsage;
  consumed: PiQuotaUsage;
  status: PiQuotaReservationStatus;
  createdAt: string;
  releasedAt?: string;
};

export type PiQuotaAdmission = {
  allowed: boolean;
  policy?: PiQuotaPolicy;
  usage: PiQuotaUsage;
  requested: PiQuotaUsage;
  reasonCode?: "policy_not_found" | "quota_exceeded" | "policy_revoked";
};

export interface PiQuotaStore {
  putPolicy(policy: PiQuotaPolicy): Promise<void>;
  listPolicies(context: RequestContext): Promise<PiQuotaPolicy[]>;
  getPolicy(context: RequestContext, policyId: string): Promise<PiQuotaPolicy | null>;
  getReservationByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiQuotaReservation | null>;
  getReservation(context: RequestContext, reservationId: string): Promise<PiQuotaReservation | null>;
  createReservation(reservation: PiQuotaReservation): Promise<{ reservation: PiQuotaReservation; created: boolean }>;
  updateReservation(context: RequestContext, reservationId: string, patch: Partial<Pick<PiQuotaReservation, "consumed" | "status" | "releasedAt">>): Promise<PiQuotaReservation>;
  summarize(context: RequestContext, policy: PiQuotaPolicy): Promise<PiQuotaUsage>;
}
