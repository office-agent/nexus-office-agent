import type { AgentMemoryRepository } from "@/src/modules/agent-memory/application/contracts";
import type { AgentMemoryEntry, MemorySearch } from "@/src/modules/agent-memory/domain/memory";

export class InMemoryAgentMemoryRepository implements AgentMemoryRepository {
  private readonly entries = new Map<string, AgentMemoryEntry>();
  private readonly sourceIndex = new Map<string, string>();

  async save(entry: AgentMemoryEntry): Promise<AgentMemoryEntry> {
    const sourceKey = `${entry.tenantId}:${entry.tier}:${entry.kind}:${entry.sourceType}:${entry.sourceId}`;
    const existingId = this.sourceIndex.get(sourceKey);
    const existing = existingId ? this.entries.get(existingId) : undefined;
    const next: AgentMemoryEntry = existing
      ? { ...structuredClone(entry), id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString(), version: existing.version + 1 }
      : structuredClone(entry);
    this.entries.set(`${next.tenantId}:${next.id}`, next);
    this.sourceIndex.set(sourceKey, next.id);
    return structuredClone(next);
  }

  async get(tenantId: string, id: string): Promise<AgentMemoryEntry | null> {
    const entry = this.entries.get(`${tenantId}:${id}`);
    return entry ? structuredClone(entry) : null;
  }

  async search(tenantId: string, input: MemorySearch): Promise<AgentMemoryEntry[]> {
    const now = Date.parse(input.now ?? new Date().toISOString());
    return [...this.entries.values()]
      .filter((entry) => entry.tenantId === tenantId && entry.status === "active" && (!entry.expiresAt || Date.parse(entry.expiresAt) > now))
      .filter((entry) => !input.tiers?.length || input.tiers.includes(entry.tier))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(input.limit, 300)))
      .map((entry) => structuredClone(entry));
  }

  async supersede(input: { tenantId: string; currentId: string; nextId: string; expectedVersion: number; updatedAt: string }): Promise<boolean> {
    const current = this.entries.get(`${input.tenantId}:${input.currentId}`);
    if (!current || current.version !== input.expectedVersion || current.status !== "active") return false;
    this.entries.set(`${input.tenantId}:${input.currentId}`, { ...current, status: input.nextId === input.currentId ? "expired" : "superseded", supersedesId: input.nextId === input.currentId ? undefined : input.nextId, version: current.version + 1, updatedAt: input.updatedAt });
    return true;
  }
}

const runtime = globalThis as typeof globalThis & { __nexusAgentMemoryRepository?: InMemoryAgentMemoryRepository; __nexusAgentMemoryFixtureVersion?: number };

export function getDevelopmentAgentMemoryRepository(): InMemoryAgentMemoryRepository {
  if (runtime.__nexusAgentMemoryFixtureVersion !== 1) {
    runtime.__nexusAgentMemoryRepository = new InMemoryAgentMemoryRepository();
    runtime.__nexusAgentMemoryFixtureVersion = 1;
  }
  return runtime.__nexusAgentMemoryRepository!;
}
