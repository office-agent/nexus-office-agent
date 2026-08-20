import type { AgentRun, Citation } from "@/src/modules/agent/domain/agent-run";
import type { AgentConfirmation, AgentProposal } from "@/src/modules/agent/domain/proposal";
import type { AgentRiskLevel } from "@/src/modules/agent/domain/agent-run";
import type { AgentJobControlAction, AgentJobControlInput, AgentToolJobInput, AgentToolJobStatus } from "@/src/platform/workers/contracts";

export type AgentToolCall = {
  id: string; tenantId: string; agentRunId: string; confirmationId?: string; toolId: string; toolVersion: number;
  riskLevel: AgentRiskLevel; idempotencyKey: string; inputDigest: string; outputDigest?: string;
  status: "queued" | "executing" | "succeeded" | "failed" | "unknown" | "dead_letter" | "cancelled" | "compensated"; errorCategory?: string; startedAt?: string; completedAt?: string;
};

export type QueuedAgentToolJob = Pick<AgentToolJobInput, "id" | "tenantId" | "proposalId"> & { status: AgentToolJobStatus };
export type AgentJobResolutionView = AgentJobControlInput & {
  resolvedBy: string;
  previousStatus: AgentToolJobStatus;
  nextStatus: AgentToolJobStatus;
  createdAt: string;
};
export type AgentToolJobView = QueuedAgentToolJob & {
  agentRunId: string;
  actorId: string;
  attempts: number;
  maxAttempts: number;
  result?: unknown;
  errorCode?: string;
  unknownReason?: string;
  resolution?: AgentJobResolutionView;
  createdAt: string;
  updatedAt: string;
};

const CONTROL_TRANSITIONS: Record<AgentJobControlAction, Partial<Record<AgentToolJobStatus, AgentToolJobStatus>>> = {
  cancel: { queued: "cancelled", retry_scheduled: "cancelled" },
  retry: { unknown: "queued", dead_letter: "queued", failed: "queued" },
  mark_succeeded: { unknown: "succeeded" },
  mark_failed: { unknown: "failed" },
  record_compensated: { unknown: "compensated", failed: "compensated", dead_letter: "compensated" },
};

export function resolveAgentJobTransition(status: AgentToolJobStatus, action: AgentJobControlAction): AgentToolJobStatus {
  const next = CONTROL_TRANSITIONS[action][status];
  if (!next) throw new Error("AGENT_JOB_STATE_CONFLICT");
  return next;
}

export interface AgentStore {
  saveRun(run: AgentRun): Promise<void>;
  getRun(tenantId: string, id: string): Promise<AgentRun | null>;
  getRunByClientRequest(tenantId: string, actorId: string, clientRequestId: string): Promise<AgentRun | null>;
  saveCitations(tenantId: string, runId: string, citations: Citation[]): Promise<void>;
  saveProposal(proposal: AgentProposal): Promise<void>;
  claimProposalConfirmation(proposal: AgentProposal): Promise<boolean>;
  getProposal(tenantId: string, id: string): Promise<AgentProposal | null>;
  saveConfirmation(confirmation: AgentConfirmation): Promise<void>;
  saveToolCall(call: AgentToolCall): Promise<void>;
  queueConfirmedProposal(input: { proposal: AgentProposal; confirmation: AgentConfirmation; toolCall: AgentToolCall; job: AgentToolJobInput }): Promise<{ job: QueuedAgentToolJob; created: boolean }>;
  getToolJobByProposal(tenantId: string, proposalId: string): Promise<QueuedAgentToolJob | null>;
  getToolJob(tenantId: string, id: string): Promise<AgentToolJobView | null>;
  controlToolJob(tenantId: string, id: string, resolvedBy: string, input: AgentJobControlInput): Promise<{ job: AgentToolJobView; created: boolean }>;
}

type InMemoryAgentJob = AgentToolJobInput & {
  status: AgentToolJobStatus;
  attempts: number;
  result?: unknown;
  errorCode?: string;
  unknownReason?: string;
  resolution?: AgentJobResolutionView;
  createdAt: string;
  updatedAt: string;
};

export class InMemoryAgentStore implements AgentStore {
  readonly runs = new Map<string, AgentRun>();
  readonly proposals = new Map<string, AgentProposal>();
  readonly confirmations = new Map<string, AgentConfirmation>();
  readonly citations = new Map<string, Citation[]>();
  readonly toolCalls = new Map<string, AgentToolCall>();
  readonly agentToolJobs = new Map<string, InMemoryAgentJob>();
  readonly agentJobResolutions = new Map<string, AgentJobResolutionView>();

  async saveRun(run: AgentRun): Promise<void> { this.runs.set(`${run.tenantId}:${run.id}`, structuredClone(run)); }
  async getRun(tenantId: string, id: string): Promise<AgentRun | null> {
    const run = this.runs.get(`${tenantId}:${id}`); return run ? structuredClone(run) : null;
  }
  async getRunByClientRequest(tenantId: string, actorId: string, clientRequestId: string): Promise<AgentRun | null> {
    const run = [...this.runs.values()].find((item) => item.tenantId === tenantId && item.actorId === actorId && item.clientRequestId === clientRequestId);
    return run ? structuredClone(run) : null;
  }
  async saveCitations(_tenantId: string, runId: string, citations: Citation[]): Promise<void> { this.citations.set(runId, structuredClone(citations)); }
  async saveProposal(proposal: AgentProposal): Promise<void> { this.proposals.set(`${proposal.tenantId}:${proposal.id}`, structuredClone(proposal)); }
  async claimProposalConfirmation(proposal: AgentProposal): Promise<boolean> {
    const key = `${proposal.tenantId}:${proposal.id}`;
    const current = this.proposals.get(key);
    if (!current || current.status !== "pending") return false;
    this.proposals.set(key, structuredClone(proposal));
    return true;
  }
  async getProposal(tenantId: string, id: string): Promise<AgentProposal | null> {
    const proposal = this.proposals.get(`${tenantId}:${id}`); return proposal ? structuredClone(proposal) : null;
  }
  async saveConfirmation(confirmation: AgentConfirmation): Promise<void> { this.confirmations.set(`${confirmation.tenantId}:${confirmation.id}`, structuredClone(confirmation)); }
  async saveToolCall(call: AgentToolCall): Promise<void> { this.toolCalls.set(`${call.tenantId}:${call.id}`, structuredClone(call)); }
  async queueConfirmedProposal(input: { proposal: AgentProposal; confirmation: AgentConfirmation; toolCall: AgentToolCall; job: AgentToolJobInput }): Promise<{ job: QueuedAgentToolJob; created: boolean }> {
    const key = `${input.job.tenantId}:${input.job.proposalId}`;
    const existing = this.agentToolJobs.get(key);
    if (existing) return { job: { id: existing.id, tenantId: existing.tenantId, proposalId: existing.proposalId, status: existing.status }, created: false };
    const current = this.proposals.get(key);
    if (!current || current.status !== "pending") throw new Error("PROPOSAL_CONFIRMATION_CONFLICT");
    this.proposals.set(key, structuredClone({ ...input.proposal, status: "queued" }));
    this.confirmations.set(`${input.confirmation.tenantId}:${input.confirmation.id}`, structuredClone(input.confirmation));
    this.toolCalls.set(`${input.toolCall.tenantId}:${input.toolCall.id}`, structuredClone(input.toolCall));
    const now = new Date().toISOString();
    this.agentToolJobs.set(key, structuredClone({ ...input.job, status: "queued", attempts: 0, createdAt: now, updatedAt: now }));
    const runKey = `${input.proposal.tenantId}:${input.proposal.agentRunId}`;
    const run = this.runs.get(runKey);
    if (run) this.runs.set(runKey, structuredClone({ ...run, status: "queued", output: { kind: "task_status", content: "已确认，任务已进入安全执行队列。", citations: run.output?.citations ?? [], proposalId: input.proposal.id } }));
    return { job: { id: input.job.id, tenantId: input.job.tenantId, proposalId: input.job.proposalId, status: "queued" }, created: true };
  }
  async getToolJobByProposal(tenantId: string, proposalId: string): Promise<QueuedAgentToolJob | null> {
    const job = this.agentToolJobs.get(`${tenantId}:${proposalId}`);
    return job ? { id: job.id, tenantId: job.tenantId, proposalId: job.proposalId, status: job.status } : null;
  }
  async getToolJob(tenantId: string, id: string): Promise<AgentToolJobView | null> {
    const job = [...this.agentToolJobs.values()].find((item) => item.tenantId === tenantId && item.id === id);
    return job ? {
      id: job.id, tenantId: job.tenantId, proposalId: job.proposalId, agentRunId: job.agentRunId, actorId: job.actorId,
      status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts, result: job.result, errorCode: job.errorCode,
      unknownReason: job.unknownReason, resolution: job.resolution ? structuredClone(job.resolution) : undefined,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
    } : null;
  }

  async controlToolJob(tenantId: string, id: string, resolvedBy: string, input: AgentJobControlInput): Promise<{ job: AgentToolJobView; created: boolean }> {
    const jobEntry = [...this.agentToolJobs.entries()].find(([, item]) => item.tenantId === tenantId && item.id === id);
    if (!jobEntry) throw new Error("AGENT_JOB_NOT_FOUND");
    const resolutionKey = `${tenantId}:${id}:${input.requestId}`;
    const existing = this.agentJobResolutions.get(resolutionKey);
    if (existing) {
      if (existing.action !== input.action) throw new Error("AGENT_JOB_RESOLUTION_CONFLICT");
      return { job: (await this.getToolJob(tenantId, id))!, created: false };
    }
    const [jobKey, job] = jobEntry;
    const nextStatus = resolveAgentJobTransition(job.status, input.action);
    const now = new Date().toISOString();
    const resolution: AgentJobResolutionView = {
      ...input, resolvedBy, previousStatus: job.status, nextStatus, createdAt: now,
    };
    const updated: InMemoryAgentJob = {
      ...job,
      status: nextStatus,
      maxAttempts: input.action === "retry" ? Math.max(job.maxAttempts, job.attempts + 1) : job.maxAttempts,
      errorCode: input.action === "retry" ? undefined : job.errorCode,
      unknownReason: input.action === "retry" ? undefined : job.unknownReason,
      result: input.action === "mark_succeeded" ? { manuallyVerified: true, evidenceDigest: input.evidenceDigest } : job.result,
      resolution,
      updatedAt: now,
    };
    this.agentToolJobs.set(jobKey, structuredClone(updated));
    this.agentJobResolutions.set(resolutionKey, structuredClone(resolution));

    const proposalKey = `${tenantId}:${job.proposalId}`;
    const proposal = this.proposals.get(proposalKey);
    const runKey = `${tenantId}:${job.agentRunId}`;
    const run = this.runs.get(runKey);
    const callKey = `${tenantId}:${job.toolCallId}`;
    const call = this.toolCalls.get(callKey);
    const relatedStatus = input.action === "retry" ? "queued" : nextStatus;
    if (proposal) this.proposals.set(proposalKey, structuredClone({ ...proposal, status: relatedStatus === "succeeded" ? "executed" : relatedStatus === "compensated" ? "cancelled" : relatedStatus as AgentProposal["status"] }));
    if (call) this.toolCalls.set(callKey, structuredClone({ ...call, status: relatedStatus === "succeeded" ? "succeeded" : relatedStatus as AgentToolCall["status"] }));
    if (run) {
      const runStatus = relatedStatus === "compensated" ? "cancelled" : relatedStatus as AgentRun["status"];
      this.runs.set(runKey, structuredClone({
        ...run,
        status: runStatus,
        completedAt: input.action === "retry" ? undefined : now,
        output: {
          kind: "task_status",
          content: input.action === "retry" ? "经人工核验未执行，任务已授权单次重放。" : `任务已由人工核验并处置为 ${nextStatus}。`,
          citations: run.output?.citations ?? [],
          proposalId: job.proposalId,
        },
      }));
    }
    return { job: (await this.getToolJob(tenantId, id))!, created: true };
  }
}
