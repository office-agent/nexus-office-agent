import type { AgentMemoryEntry, MemorySearch } from "@/src/modules/agent-memory/domain/memory";

export interface AgentMemoryRepository {
  save(entry: AgentMemoryEntry): Promise<AgentMemoryEntry>;
  get(tenantId: string, id: string): Promise<AgentMemoryEntry | null>;
  search(tenantId: string, input: MemorySearch): Promise<AgentMemoryEntry[]>;
  supersede(input: { tenantId: string; currentId: string; nextId: string; expectedVersion: number; updatedAt: string }): Promise<boolean>;
}
