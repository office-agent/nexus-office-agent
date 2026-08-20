import type { RequestContext, DataScope } from "@/src/platform/context/request-context";
import type { PiProfileId, PiSession } from "@/src/modules/pi-agent/domain/contracts";
import type { PiAgentProfileSnapshot, PiDelegationBudget } from "@/src/modules/pi-agent/domain/profile-contracts";

export type PiChildRunStatus = "proposed" | "admitted" | "queued" | "running" | "completed" | "failed" | "cancelled";

export type PiDelegation = {
  id: string;
  tenantId: string;
  parentSessionId: string;
  parentBranchId?: string;
  childSessionId?: string;
  parentRunId?: string;
  childRunId?: string;
  profileId: PiProfileId;
  profileVersion: number;
  profileDigest: string;
  depth: number;
  status: PiChildRunStatus;
  budget: PiDelegationBudget;
  allowedTools: string[];
  dataScopes: DataScope[];
  idempotencyKey: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type PiDelegationRequest = {
  parentSessionId: string;
  parentBranchId?: string;
  profile: PiProfileId;
  budget?: Partial<PiDelegationBudget>;
  idempotencyKey: string;
};

export type PiDelegationAdmission = {
  profile: PiAgentProfileSnapshot;
  parentProfile: PiAgentProfileSnapshot;
  depth: number;
  budget: PiDelegationBudget;
  allowedTools: string[];
  dataScopes: DataScope[];
};

export type PiChildResult = {
  delegation: PiDelegation;
  childSession?: PiSession;
  eventCount: number;
  latestEventSequence: number;
  resultDigest: string;
  terminal: boolean;
};

export interface PiDelegationStore {
  findByIdempotency(context: RequestContext, parentSessionId: string, idempotencyKey: string): Promise<PiDelegation | null>;
  get(context: RequestContext, delegationId: string): Promise<PiDelegation | null>;
  getByChildSession(context: RequestContext, childSessionId: string): Promise<PiDelegation | null>;
  listByParent(context: RequestContext, parentSessionId: string): Promise<PiDelegation[]>;
  countActiveByParent(context: RequestContext, parentSessionId: string): Promise<number>;
  create(delegation: PiDelegation): Promise<PiDelegation>;
  update(context: RequestContext, delegationId: string, expectedVersion: number, patch: Partial<Pick<PiDelegation, "childSessionId" | "childRunId" | "status" | "version">>): Promise<PiDelegation>;
}

export interface PiChildSessionFactory {
  createChildSession(context: RequestContext, parent: PiSession, admission: PiDelegationAdmission, delegationId: string): Promise<PiSession>;
}

