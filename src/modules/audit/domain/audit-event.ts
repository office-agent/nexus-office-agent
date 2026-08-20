import { createHash, randomUUID } from "node:crypto";
import type { Channel } from "@/src/platform/context/request-context";

const SENSITIVE_KEYS = /authorization|cookie|secret|token|password|api[-_]?key|encodingaeskey/i;

export type AuditEvent = {
  id: string;
  occurredAt: Date;
  tenantId: string;
  actorType: "user" | "agent" | "system";
  actorId: string;
  channel: Channel;
  traceId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  decision: "allowed" | "denied" | "executed" | "failed";
  policyId?: string;
  policyVersion?: number;
  beforeDigest?: string;
  afterDigest?: string;
  confirmationId?: string;
  agentRunId?: string;
  metadata: Record<string, unknown>;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(redactSensitive(value)))).digest("hex");
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redactSensitive(entry)]),
    );
  }
  return value;
}

export function createAuditEvent(
  input: Omit<AuditEvent, "id" | "occurredAt" | "metadata"> & { metadata?: Record<string, unknown> },
): AuditEvent {
  return {
    ...input,
    id: randomUUID(),
    occurredAt: new Date(),
    metadata: redactSensitive(input.metadata ?? {}) as Record<string, unknown>,
  };
}
