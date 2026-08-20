import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiCheckpoint, PiSession, PiSessionEvent, PiSessionStore } from "@/src/modules/pi-agent/domain/contracts";

export type PiSessionBranchStatus = "active" | "archived";

export type PiSessionBranch = {
  id: string;
  tenantId: string;
  sessionId: string;
  parentBranchId?: string;
  baseEventSequence: number;
  headEventSequence: number;
  label: string;
  status: PiSessionBranchStatus;
  version: number;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type PiContextSummary = {
  id: string;
  tenantId: string;
  sessionId: string;
  branchId: string;
  sourceStartSequence: number;
  sourceEndSequence: number;
  sourceEventIds: string[];
  eventTypes: string[];
  summary: unknown;
  summaryDigest: string;
  compactionVersion: number;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
};

export type PiSessionTree = {
  session: PiSession;
  rootBranch: PiSessionBranch;
  branches: PiSessionBranch[];
  summaries: PiContextSummary[];
  continuityDigest: string;
};

export type PiSessionHistory = {
  session: PiSession;
  branch: PiSessionBranch;
  events: PiSessionEvent[];
  checkpoints: PiCheckpoint[];
  summaries: PiContextSummary[];
  continuityDigest: string;
};

export type PiForkInput = {
  parentBranchId?: string;
  baseEventSequence?: number;
  checkpointId?: string;
  label: string;
  expectedParentVersion?: number;
  idempotencyKey: string;
};

export type PiCompactInput = {
  branchId?: string;
  maxEvents?: number;
  expectedBranchVersion?: number;
  idempotencyKey: string;
};

export type PiContextCompactionInput = {
  session: PiSession;
  branch: PiSessionBranch;
  events: PiSessionEvent[];
  previousSummary?: PiContextSummary;
  createdBy: string;
};

export type PiContextCompactionOutput = {
  sourceStartSequence: number;
  sourceEndSequence: number;
  sourceEventIds: string[];
  eventTypes: string[];
  summary: unknown;
};

export interface PiContextCompactor {
  compact(input: PiContextCompactionInput): Promise<PiContextCompactionOutput>;
}

export interface PiSessionTreeStore {
  findBranchByIdempotency(context: RequestContext, sessionId: string, idempotencyKey: string): Promise<PiSessionBranch | null>;
  getBranch(context: RequestContext, sessionId: string, branchId: string): Promise<PiSessionBranch | null>;
  listBranches(context: RequestContext, sessionId: string): Promise<PiSessionBranch[]>;
  createBranch(branch: PiSessionBranch): Promise<PiSessionBranch>;
  updateBranch(context: RequestContext, branchId: string, expectedVersion: number, patch: Partial<Pick<PiSessionBranch, "headEventSequence" | "status">>): Promise<PiSessionBranch>;
  findSummaryByIdempotency(context: RequestContext, sessionId: string, branchId: string, idempotencyKey: string): Promise<PiContextSummary | null>;
  createSummary(summary: PiContextSummary): Promise<PiContextSummary>;
  listSummaries(context: RequestContext, sessionId: string, branchId?: string): Promise<PiContextSummary[]>;
}

export type PiSessionTreeServiceDependencies = {
  sessionStore: PiSessionStore;
  treeStore: PiSessionTreeStore;
  compactor?: PiContextCompactor;
};
