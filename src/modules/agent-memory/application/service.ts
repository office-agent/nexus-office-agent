import { randomUUID } from "node:crypto";
import type { Citation } from "@/src/modules/agent/domain/agent-run";
import type { AgentMemoryRepository } from "@/src/modules/agent-memory/application/contracts";
import { createMemoryEntry, defaultMemoryExpiry, memoryTokens, type AgentMemoryContext, type AgentMemoryEntry, type MemoryClassification } from "@/src/modules/agent-memory/domain/memory";
import type { RequestContext } from "@/src/platform/context/request-context";
import { classifyUntrustedText, hasSensitiveContent, mostRestrictiveClassification, type DataClassification } from "@/src/platform/security/data-classification";
import { incrementCounter } from "@/src/platform/observability/telemetry";

type RememberInput = {
  summary: string; scopeType: "user" | "project" | "tenant"; scopeId?: string; visibility: "private" | "shared";
  classification: MemoryClassification; importance: number; confidence: number; sourceRefs: string[]; expiresAt?: string;
};
type ContextInput = {
  conversationId?: string; projectId?: string; query: string; taskIds?: string[]; missionIds?: string[]; situationScopeIds?: string[]; limit?: number;
};

function hasPermission(context: RequestContext, permission: string): boolean {
  const [resource, action] = permission.split(":");
  return context.permissions.some((item) => item === "*" || item === permission || item === `${resource}:*` || item === `*:${action}`);
}

function requirePermission(context: RequestContext, permission: string): void {
  if (!hasPermission(context, permission)) throw new Error(`POLICY_DENIED:${permission}`);
}

function includesEntry(context: RequestContext, entry: AgentMemoryEntry, input: ContextInput, includeShared: boolean): boolean {
  if (entry.status !== "active" || (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now())) return false;
  if (entry.tier === "conversation") return entry.scopeType === "conversation" && entry.scopeId === input.conversationId && entry.ownerId === context.actorId;
  if (entry.tier === "task") return entry.scopeType === "task" && (input.taskIds ?? []).includes(entry.scopeId);
  if (entry.tier === "situational") return entry.scopeType === "project" && [input.projectId, ...(input.situationScopeIds ?? [])].includes(entry.scopeId);
  if (entry.tier === "context") {
    return entry.ownerId === context.actorId && (
      (entry.scopeType === "conversation" && entry.scopeId === input.conversationId) ||
      (entry.scopeType === "project" && entry.scopeId === input.projectId)
    );
  }
  if (entry.tier === "long_term") {
    if (entry.visibility === "private") return entry.ownerId === context.actorId;
    return includeShared && hasPermission(context, "memory:read_shared");
  }
  return false;
}

function rank(entries: AgentMemoryEntry[], query: string, limit: number): AgentMemoryEntry[] {
  const queryTokens = memoryTokens(query);
  const scored = entries.map((entry) => {
    const entryTokens = new Set(memoryTokens(`${entry.summary} ${entry.kind} ${entry.sourceRefs.join(" ")}`));
    const overlap = queryTokens.filter((token) => entryTokens.has(token)).length;
    const freshness = Math.max(0, 20 - Math.floor((Date.now() - Date.parse(entry.updatedAt)) / (24 * 60 * 60 * 1000)));
    return { entry, score: overlap * 30 + entry.importance + Math.round(entry.confidence / 10) + freshness };
  });
  return scored.sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt)).slice(0, limit).map(({ entry }) => entry);
}

function memoryCitation(entry: AgentMemoryEntry): Citation {
  return {
    id: randomUUID(), objectType: `agent_memory.${entry.tier}`, objectId: entry.id, objectVersion: entry.version,
    label: `记忆 · ${entry.kind}`, excerpt: entry.summary.slice(0, 360), classification: entry.classification, retrievedAt: new Date().toISOString(),
  };
}

export class AgentMemoryService {
  constructor(private readonly repository: AgentMemoryRepository) {}

  async remember(context: RequestContext, input: RememberInput): Promise<AgentMemoryEntry> {
    requirePermission(context, "memory:write");
    if (input.visibility === "shared") requirePermission(context, "memory:share");
    if (hasSensitiveContent(input.summary)) throw new Error("MEMORY_SENSITIVE_CONTENT_PROHIBITED");
    if (input.scopeType === "tenant" && input.visibility !== "shared") throw new Error("MEMORY_TENANT_SCOPE_REQUIRES_SHARED_VISIBILITY");
    const scopeId = input.scopeType === "user" ? context.actorId : input.scopeId;
    if (!scopeId) throw new Error("MEMORY_SCOPE_REQUIRED");
    const id = randomUUID();
    const entry = await this.repository.save(createMemoryEntry({
      id, tenantId: context.tenantId, tier: "long_term", kind: "declared_fact", scopeType: input.scopeType, scopeId,
      ownerId: input.visibility === "private" ? context.actorId : undefined, visibility: input.visibility, classification: input.classification,
      summary: input.summary, attributes: {}, sourceRefs: input.sourceRefs, sourceType: "memory_declaration", sourceId: id,
      origin: "user_declared", importance: input.importance, confidence: input.confidence, expiresAt: input.expiresAt, createdBy: context.actorId,
    }));
    incrementCounter("agent.memory.long_term_write.total", { classification: input.classification, visibility: input.visibility });
    return entry;
  }

  async recall(context: RequestContext, input: { query?: string; limit: number; includeShared: boolean; forModel?: boolean }): Promise<AgentMemoryEntry[]> {
    requirePermission(context, "memory:read");
    const entries = await this.repository.search(context.tenantId, { query: input.query, tiers: ["long_term"], includeShared: input.includeShared, limit: 100 });
    const selected = rank(entries.filter((entry) => includesEntry(context, entry, { query: input.query ?? "" }, input.includeShared) && (!input.forModel || entry.classification !== "restricted")), input.query ?? "", input.limit);
    incrementCounter("agent.memory.recall.total", { audience: input.forModel ? "model" : "user" });
    return selected;
  }

  async context(context: RequestContext, input: ContextInput): Promise<AgentMemoryContext> {
    const entries = await this.repository.search(context.tenantId, { query: input.query, limit: 180 });
    const visible = entries.filter((entry) => includesEntry(context, entry, input, true) && entry.classification !== "restricted");
    const selected = rank(visible, input.query, input.limit ?? 12);
    const summary = selected.length
      ? ["<untrusted_memory_context>", ...selected.map((entry) => `[${entry.tier}/${entry.kind}/${entry.classification}] ${entry.summary}`), "</untrusted_memory_context>"].join("\n")
      : "<untrusted_memory_context>没有可用的已沉淀记忆。</untrusted_memory_context>";
    incrementCounter("agent.memory.context.total", { outcome: selected.length ? "populated" : "empty" });
    return { summary, citations: selected.map(memoryCitation), entries: selected };
  }

  async captureConversation(context: RequestContext, input: { conversationId: string; runId: string; summary: string; classification?: MemoryClassification }): Promise<AgentMemoryEntry | null> {
    const classification = input.classification ?? classifyUntrustedText(input.summary);
    if (classification === "restricted") return null;
    return this.repository.save(createMemoryEntry({
      tenantId: context.tenantId, tier: "conversation", kind: "turn", scopeType: "conversation", scopeId: input.conversationId,
      ownerId: context.actorId, visibility: "private", classification,
      summary: input.summary.slice(0, 1_200),
      attributes: { runId: input.runId }, sourceRefs: [`agent_run:${input.runId}`], sourceType: "agent_run", sourceId: input.runId,
      origin: "conversation", importance: 35, confidence: 100, expiresAt: defaultMemoryExpiry("conversation"), createdBy: context.actorId,
    }));
  }

  async captureContext(context: RequestContext, input: { conversationId?: string; projectId: string; runId: string; summary: string; citations: Citation[] }): Promise<AgentMemoryEntry | null> {
    const classification = mostRestrictiveClassification(input.citations.map(({ classification: value }) => value));
    if (classification === "restricted" || classifyUntrustedText(input.summary, classification) === "restricted") return null;
    const scopeType = input.conversationId ? "conversation" : "project";
    const scopeId = input.conversationId ?? input.projectId;
    return this.repository.save(createMemoryEntry({
      tenantId: context.tenantId, tier: "context", kind: "authorized_context_snapshot", scopeType, scopeId, ownerId: context.actorId,
      visibility: "private", classification, summary: input.summary.slice(0, 1_800),
      attributes: { projectId: input.projectId, citationIds: input.citations.map(({ objectId }) => objectId).slice(0, 24) },
      sourceRefs: input.citations.map(({ objectType, objectId }) => `${objectType}:${objectId}`).slice(0, 40), sourceType: "agent_run", sourceId: `${input.runId}:context`,
      origin: "context", importance: 45, confidence: 100, expiresAt: defaultMemoryExpiry("context"), createdBy: context.actorId,
    }));
  }

  async captureSituation(context: RequestContext, input: { projectId: string; runId: string; summary: string; citations: Citation[] }): Promise<AgentMemoryEntry | null> {
    const classification = mostRestrictiveClassification(input.citations.map(({ classification: value }) => value));
    if (classification === "restricted" || !["public", "internal"].includes(classification) || classifyUntrustedText(input.summary, classification) === "restricted") return null;
    return this.repository.save(createMemoryEntry({
      tenantId: context.tenantId, tier: "situational", kind: "project_operating_picture", scopeType: "project", scopeId: input.projectId,
      visibility: "shared", classification, summary: input.summary.slice(0, 1_800),
      attributes: { citationCount: input.citations.length }, sourceRefs: input.citations.map(({ objectType, objectId }) => `${objectType}:${objectId}`).slice(0, 40),
      sourceType: "agent_run", sourceId: `${input.runId}:situation`, origin: "situation", importance: 55, confidence: 90,
      expiresAt: defaultMemoryExpiry("situational"), createdBy: context.actorId,
    }));
  }

  async captureTask(context: RequestContext, input: { taskId: string; taskVersion: number; runId: string; summary: string; sourceRefs: string[]; classification?: DataClassification }): Promise<AgentMemoryEntry | null> {
    const classification = input.classification ?? classifyUntrustedText(input.summary);
    if (classification === "restricted" || !["public", "internal"].includes(classification)) return null;
    return this.repository.save(createMemoryEntry({
      tenantId: context.tenantId, tier: "task", kind: "task_snapshot", scopeType: "task", scopeId: input.taskId,
      visibility: "shared", classification, summary: input.summary.slice(0, 1_800), attributes: { taskVersion: input.taskVersion },
      sourceRefs: input.sourceRefs.slice(0, 40), sourceType: "work_package", sourceId: input.taskId,
      origin: "task", importance: 65, confidence: 100, expiresAt: defaultMemoryExpiry("task"), createdBy: context.actorId,
    }));
  }

  async captureTaskHandoff(context: RequestContext, input: { taskId: string; handoffId: string; runId: string; summary: string; sourceRefs: string[]; classification?: DataClassification }): Promise<AgentMemoryEntry | null> {
    const classification = input.classification ?? classifyUntrustedText(input.summary);
    if (classification === "restricted" || !["public", "internal"].includes(classification)) return null;
    return this.repository.save(createMemoryEntry({
      tenantId: context.tenantId, tier: "task", kind: "handoff_snapshot", scopeType: "task", scopeId: input.taskId,
      visibility: "shared", classification, summary: input.summary.slice(0, 1_800), attributes: { handoffId: input.handoffId },
      sourceRefs: input.sourceRefs.slice(0, 40), sourceType: "work_task_handoff", sourceId: input.handoffId,
      origin: "task", importance: 75, confidence: 100, expiresAt: defaultMemoryExpiry("task"), createdBy: context.actorId,
    }));
  }

  async expire(context: RequestContext, id: string, expectedVersion: number): Promise<void> {
    const current = await this.repository.get(context.tenantId, id);
    if (!current) throw new Error("MEMORY_NOT_FOUND");
    if (current.ownerId !== context.actorId && !hasPermission(context, "memory:manage")) throw new Error("POLICY_DENIED:memory:manage");
    const changed = await this.repository.supersede({ tenantId: context.tenantId, currentId: id, nextId: id, expectedVersion, updatedAt: new Date().toISOString() });
    if (!changed) throw new Error("MEMORY_VERSION_CONFLICT");
  }
}
