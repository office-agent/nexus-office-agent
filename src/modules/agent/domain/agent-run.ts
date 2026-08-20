import { createHash, randomUUID } from "node:crypto";
import type { Channel } from "@/src/platform/context/request-context";
import type { DataClassification } from "@/src/platform/security/data-classification";

export type AgentRiskLevel = 0 | 1 | 2 | 3 | 4;
export type AgentAutonomy = "L0" | "L1" | "L2" | "L3";
export type AgentRunStatus = "created" | "running" | "awaiting_confirmation" | "queued" | "executing" | "succeeded" | "failed" | "unknown" | "awaiting_human" | "cancelled";
export type AgentOutputKind = "answer" | "insight" | "draft" | "proposal" | "task_status" | "execution" | "refusal";

export type Citation = {
  id: string;
  objectType: string;
  objectId: string;
  objectVersion?: number;
  label: string;
  excerpt: string;
  classification: DataClassification;
  retrievedAt: string;
};

export type AgentOutput = {
  kind: AgentOutputKind;
  content: string;
  citations: Citation[];
  proposalId?: string;
  routing?: { skills: string[]; tools: string[] };
};

export type AgentRun = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  channel: Channel;
  traceId: string;
  clientRequestId?: string;
  conversationId?: string;
  agentProfile: string;
  profileVersion: number;
  modelPolicy: string;
  autonomy: AgentAutonomy;
  riskLevel: AgentRiskLevel;
  status: AgentRunStatus;
  message: string;
  contextRefs: string[];
  inputDigest: string;
  output?: AgentOutput;
  usage: { provider?: string; model?: string; inputTokens?: number; outputTokens?: number; latencyMs?: number; degraded?: boolean };
  failureCategory?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
};

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createAgentRun(input: {
  tenantId: string; actorId: string; sessionId: string; channel: Channel; traceId: string;
  clientRequestId?: string; conversationId?: string; message: string; contextRefs: string[];
}): AgentRun {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), ...input, agentProfile: "manager-assistant", profileVersion: 1,
    modelPolicy: "tenant-default-v2-skill-tool", autonomy: "L2", riskLevel: 1, status: "created",
    inputDigest: sha256(JSON.stringify({ message: input.message, contextRefs: input.contextRefs })),
    usage: {}, createdAt: now,
  };
}
