import { createHash } from "node:crypto";
import type { UnifiedEvent } from "@/src/modules/events/domain/event-envelope";
import type { AgentRiskLevel } from "@/src/modules/agent/domain/agent-run";
import type { Channel } from "@/src/platform/context/request-context";

export type WorkerRole = "inbox" | "agent" | "outbox" | "pi-runner" | "pi-change-delivery";

export type LeaseRequest = {
  workerId: string;
  leaseMs: number;
  maxTenantConcurrency?: number;
  now?: Date;
};

export type WorkFailure = {
  code: string;
  digest: string;
};

export type RetryDisposition = "retry_scheduled" | "dead_letter";

export type InboxLease = {
  id: string;
  tenantId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attempts: number;
  maxAttempts: number;
  event: UnifiedEvent;
};

export type OutboxLease = {
  id: string;
  tenantId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attempts: number;
  maxAttempts: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  payload: Record<string, unknown>;
  traceId: string;
  occurredAt: string;
};

export type AgentToolJobStatus =
  | "queued"
  | "executing"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "unknown"
  | "dead_letter"
  | "cancelled"
  | "compensated";

export type AgentJobControlAction = "cancel" | "retry" | "mark_succeeded" | "mark_failed" | "record_compensated";

export type AgentJobControlInput = {
  requestId: string;
  action: AgentJobControlAction;
  reason: string;
  evidenceDigest?: string;
  evidenceSummary?: string;
};

export type AgentToolJobInput = {
  id: string;
  tenantId: string;
  agentRunId: string;
  proposalId: string;
  confirmationId: string;
  toolCallId: string;
  actorId: string;
  sessionId?: string;
  channel: Channel;
  connectionId?: string;
  traceId: string;
  toolId: string;
  toolVersion: number;
  policyVersion: number;
  riskLevel: AgentRiskLevel;
  inputPayload: Record<string, unknown>;
  inputDigest: string;
  idempotencyKey: string;
  expectedVersions: Record<string, number>;
  maxAttempts: number;
  availableAt?: string;
};

export type AgentToolJobLease = AgentToolJobInput & {
  leaseToken: string;
  leaseExpiresAt: string;
  attempts: number;
  status: "executing";
};

export class RetryableWorkError extends Error {
  readonly category = "retryable" as const;
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "RetryableWorkError";
  }
}

export class NonRetryableWorkError extends Error {
  readonly category = "non_retryable" as const;
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "NonRetryableWorkError";
  }
}

export class UnknownOutcomeWorkError extends Error {
  readonly category = "unknown" as const;
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "UnknownOutcomeWorkError";
  }
}

export function failureFrom(error: unknown): WorkFailure {
  const code = error instanceof RetryableWorkError || error instanceof NonRetryableWorkError || error instanceof UnknownOutcomeWorkError
    ? error.code
    : error instanceof Error
      ? error.message.split(":")[0] || "WORK_FAILED"
      : "WORK_FAILED";
  const safeShape = error instanceof Error ? `${error.name}:${code}` : `${typeof error}:${code}`;
  return { code, digest: createHash("sha256").update(safeShape).digest("hex") };
}

export function retryAt(attempt: number, now = new Date(), baseMs = 1_000, maximumMs = 60_000): Date {
  const boundedAttempt = Math.max(1, Math.min(attempt, 16));
  const delay = Math.min(maximumMs, baseMs * (2 ** (boundedAttempt - 1)));
  return new Date(now.getTime() + delay);
}
