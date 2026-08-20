import { createHash, randomUUID } from "node:crypto";
import { dataClassifications, type DataClassification } from "@/src/platform/security/data-classification";
import type { Citation } from "@/src/modules/agent/domain/agent-run";

export const memoryTiers = ["conversation", "context", "long_term", "task", "situational"] as const;
export type MemoryTier = (typeof memoryTiers)[number];
export const memoryVisibilities = ["private", "shared"] as const;
export type MemoryVisibility = (typeof memoryVisibilities)[number];
export const memoryClassifications = dataClassifications;
export type MemoryClassification = DataClassification;
export const memoryScopeTypes = ["user", "tenant", "conversation", "project", "mission", "task", "meeting", "case"] as const;
export type MemoryScopeType = (typeof memoryScopeTypes)[number];
export const memoryOrigins = ["user_declared", "conversation", "context", "task", "situation", "system"] as const;
export type MemoryOrigin = (typeof memoryOrigins)[number];
export type MemoryStatus = "active" | "superseded" | "expired" | "revoked";

export type AgentMemoryEntry = {
  id: string;
  tenantId: string;
  tier: MemoryTier;
  kind: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  ownerId?: string;
  visibility: MemoryVisibility;
  classification: MemoryClassification;
  summary: string;
  attributes: Record<string, unknown>;
  sourceRefs: string[];
  sourceType: string;
  sourceId: string;
  origin: MemoryOrigin;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  expiresAt?: string;
  supersedesId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type MemorySearch = {
  query?: string;
  tiers?: MemoryTier[];
  scopeIds?: Partial<Record<MemoryScopeType, string[]>>;
  conversationId?: string;
  includeShared?: boolean;
  limit: number;
  now?: string;
};

export type AgentMemoryContext = {
  summary: string;
  citations: Citation[];
  entries: AgentMemoryEntry[];
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function defaultMemoryExpiry(tier: MemoryTier, now = new Date()): string | undefined {
  const durationMs: Record<Exclude<MemoryTier, "long_term">, number> = {
    conversation: 30 * 24 * 60 * 60 * 1000,
    context: 24 * 60 * 60 * 1000,
    task: 180 * 24 * 60 * 60 * 1000,
    situational: 14 * 24 * 60 * 60 * 1000,
  };
  if (tier === "long_term") return undefined;
  return new Date(now.getTime() + durationMs[tier]).toISOString();
}

export function createMemoryEntry(input: Omit<AgentMemoryEntry, "id" | "createdAt" | "updatedAt" | "version" | "status"> & { id?: string; createdAt?: string; updatedAt?: string; version?: number; status?: MemoryStatus }): AgentMemoryEntry {
  const now = input.createdAt ?? new Date().toISOString();
  const summary = input.summary.trim().replace(/\s+/g, " ");
  if (!summary || summary.length > 2_000) throw new Error("MEMORY_SUMMARY_INVALID");
  if (!Number.isInteger(input.importance) || input.importance < 0 || input.importance > 100) throw new Error("MEMORY_IMPORTANCE_INVALID");
  if (!Number.isInteger(input.confidence) || input.confidence < 0 || input.confidence > 100) throw new Error("MEMORY_CONFIDENCE_INVALID");
  if (input.visibility === "shared" && input.tier === "conversation") throw new Error("MEMORY_CONVERSATION_CANNOT_BE_SHARED");
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.parse(now)) throw new Error("MEMORY_EXPIRY_INVALID");
  return {
    id: input.id ?? randomUUID(), tenantId: input.tenantId, tier: input.tier, kind: input.kind.trim(),
    scopeType: input.scopeType, scopeId: input.scopeId, ownerId: input.ownerId, visibility: input.visibility,
    classification: input.classification, summary, attributes: structuredClone(input.attributes),
    sourceRefs: [...new Set(input.sourceRefs.map((item) => item.trim()).filter(Boolean))].slice(0, 40),
    sourceType: input.sourceType, sourceId: input.sourceId, origin: input.origin,
    importance: input.importance, confidence: input.confidence, status: input.status ?? "active",
    expiresAt: input.expiresAt, supersedesId: input.supersedesId, createdBy: input.createdBy,
    createdAt: now, updatedAt: input.updatedAt ?? now, version: input.version ?? 1,
  };
}

export function memoryDigest(entry: Pick<AgentMemoryEntry, "tier" | "kind" | "scopeType" | "scopeId" | "summary" | "sourceRefs" | "attributes">): string {
  return digest(JSON.stringify(entry));
}

export function memoryTokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 64);
}
