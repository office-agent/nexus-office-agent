import type { AgentMemoryRepository } from "@/src/modules/agent-memory/application/contracts";
import type { AgentMemoryEntry, MemorySearch } from "@/src/modules/agent-memory/domain/memory";
import type { TransactionalDatabase } from "@/src/platform/database/executor";

type Row = Record<string, unknown>;
const text = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalText = (value: unknown) => value === null || value === undefined ? undefined : text(value);
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

function mapEntry(row: Row): AgentMemoryEntry {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), tier: row.tier as AgentMemoryEntry["tier"], kind: text(row.kind),
    scopeType: row.scope_type as AgentMemoryEntry["scopeType"], scopeId: text(row.scope_id), ownerId: optionalText(row.owner_id),
    visibility: row.visibility as AgentMemoryEntry["visibility"], classification: row.classification as AgentMemoryEntry["classification"],
    summary: text(row.summary), attributes: json<Record<string, unknown>>(row.attributes), sourceRefs: json<string[]>(row.source_refs),
    sourceType: text(row.source_type), sourceId: text(row.source_id), origin: row.origin as AgentMemoryEntry["origin"],
    importance: Number(row.importance), confidence: Number(row.confidence), status: row.status as AgentMemoryEntry["status"],
    expiresAt: optionalText(row.expires_at), supersedesId: optionalText(row.supersedes_id), createdBy: text(row.created_by),
    createdAt: text(row.created_at), updatedAt: text(row.updated_at), version: Number(row.version),
  };
}

export class PostgresAgentMemoryRepository implements AgentMemoryRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async save(entry: AgentMemoryEntry): Promise<AgentMemoryEntry> {
    return this.database.withTenant(entry.tenantId, async (db) => {
      const rows = await db.query(`INSERT INTO agent_memory_entries(
        id,tenant_id,tier,kind,scope_type,scope_id,owner_id,visibility,classification,summary,attributes,source_refs,
        source_type,source_id,origin,importance,confidence,status,expires_at,supersedes_id,created_by,created_at,updated_at,version
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      ON CONFLICT (tenant_id,tier,kind,source_type,source_id) DO UPDATE SET
        scope_type=EXCLUDED.scope_type,scope_id=EXCLUDED.scope_id,owner_id=EXCLUDED.owner_id,visibility=EXCLUDED.visibility,
        classification=EXCLUDED.classification,summary=EXCLUDED.summary,attributes=EXCLUDED.attributes,source_refs=EXCLUDED.source_refs,
        origin=EXCLUDED.origin,importance=EXCLUDED.importance,confidence=EXCLUDED.confidence,status=EXCLUDED.status,
        expires_at=EXCLUDED.expires_at,supersedes_id=EXCLUDED.supersedes_id,updated_at=EXCLUDED.updated_at,version=agent_memory_entries.version+1
      RETURNING *`, [
        entry.id,entry.tenantId,entry.tier,entry.kind,entry.scopeType,entry.scopeId,entry.ownerId ?? null,entry.visibility,entry.classification,
        entry.summary,entry.attributes,entry.sourceRefs,entry.sourceType,entry.sourceId,entry.origin,entry.importance,entry.confidence,
        entry.status,entry.expiresAt ?? null,entry.supersedesId ?? null,entry.createdBy,entry.createdAt,entry.updatedAt,entry.version,
      ]);
      if (!rows[0]) throw new Error("MEMORY_SAVE_FAILED");
      return mapEntry(rows[0]);
    });
  }

  async get(tenantId: string, id: string): Promise<AgentMemoryEntry | null> {
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query("SELECT * FROM agent_memory_entries WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
      return rows[0] ? mapEntry(rows[0]) : null;
    });
  }

  async search(tenantId: string, input: MemorySearch): Promise<AgentMemoryEntry[]> {
    return this.database.withTenant(tenantId, async (db) => {
      const tiers = input.tiers?.length ? input.tiers : null;
      const rows = await db.query(`SELECT * FROM agent_memory_entries
        WHERE tenant_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>$2)
          AND ($3::text[] IS NULL OR tier=ANY($3::text[]))
        ORDER BY updated_at DESC,id DESC LIMIT $4`, [tenantId, input.now ?? new Date().toISOString(), tiers, Math.max(1, Math.min(input.limit, 300))]);
      return rows.map(mapEntry);
    });
  }

  async supersede(input: { tenantId: string; currentId: string; nextId: string; expectedVersion: number; updatedAt: string }): Promise<boolean> {
    return this.database.withTenant(input.tenantId, async (db) => {
      const rows = await db.query(`UPDATE agent_memory_entries
        SET status=$3,supersedes_id=$4,updated_at=$5,version=version+1
        WHERE tenant_id=$1 AND id=$2 AND version=$6 AND status='active' RETURNING id`, [
        input.tenantId, input.currentId, input.nextId === input.currentId ? "expired" : "superseded", input.nextId === input.currentId ? null : input.nextId, input.updatedAt, input.expectedVersion,
      ]);
      return rows.length === 1;
    });
  }
}
