import type { TransactionalDatabase } from "@/src/platform/database/executor";
import type { KnowledgeRepository } from "@/src/modules/knowledge/application/contracts";
import type { Document, DocumentAccess, DocumentVersion, KnowledgeItem } from "@/src/modules/knowledge/domain/document";

type Row = Record<string, unknown>;
const asText = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalText = (value: unknown) => value === null || value === undefined ? undefined : asText(value);
function json<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }

function mapDocument(row: Row): Document {
  return {
    id: asText(row.id), tenantId: asText(row.tenant_id), title: asText(row.title), ownerId: asText(row.owner_id),
    classification: row.classification as Document["classification"], status: row.status as Document["status"],
    currentVersion: Number(row.current_version), access: json<DocumentAccess>(row.access_policy), version: Number(row.version),
  };
}
function mapVersion(row: Row): DocumentVersion {
  return {
    id: asText(row.id), tenantId: asText(row.tenant_id), documentId: asText(row.document_id), version: Number(row.version),
    content: asText(row.content), contentDigest: asText(row.content_digest), sourceRef: optionalText(row.source_ref),
    effectiveAt: asText(row.effective_at), expiresAt: optionalText(row.expires_at),
    supersedesVersion: row.supersedes_version == null ? undefined : Number(row.supersedes_version),
    publishedBy: asText(row.published_by), publishedAt: asText(row.published_at),
  };
}
function mapItem(row: Row): KnowledgeItem {
  return {
    id: asText(row.id), tenantId: asText(row.tenant_id), documentId: asText(row.document_id), documentVersion: Number(row.document_version),
    chunkIndex: Number(row.chunk_index), content: asText(row.content), locator: asText(row.locator),
    permissionSnapshot: json<DocumentAccess>(row.permission_snapshot), status: row.status as KnowledgeItem["status"],
    contentDigest: asText(row.content_digest),
  };
}

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly database: TransactionalDatabase) {}
  async getDocument(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM documents WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapDocument(rows[0]) : null;
    });
  }
  async getDocumentVersion(tenantId: string, documentId: string, version: number) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM document_versions WHERE tenant_id=$1 AND document_id=$2 AND version=$3", [tenantId,documentId,version]);
      return rows[0] ? mapVersion(rows[0]) : null;
    });
  }
  async listPublishedDocuments(tenantId: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM documents WHERE tenant_id=$1 AND status='published' ORDER BY title", [tenantId]);
      return rows.map(mapDocument);
    });
  }
  async savePublishedDocument(document: Document, version: DocumentVersion, items: KnowledgeItem[]): Promise<void> {
    await this.database.withTenant(document.tenantId, async (executor) => {
      await executor.query("UPDATE knowledge_items SET status='invalidated',invalidated_at=now() WHERE tenant_id=$1 AND document_id=$2 AND status='active'", [document.tenantId,document.id]);
      await executor.query(
        `INSERT INTO documents(id,tenant_id,title,owner_id,classification,status,current_version,access_policy,version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,classification=EXCLUDED.classification,status=EXCLUDED.status,current_version=EXCLUDED.current_version,access_policy=EXCLUDED.access_policy,version=EXCLUDED.version,updated_at=now()`,
        [document.id,document.tenantId,document.title,document.ownerId,document.classification,document.status,document.currentVersion,document.access,document.version],
      );
      await executor.query(
        `INSERT INTO document_versions(id,tenant_id,document_id,version,content,content_digest,source_ref,effective_at,expires_at,supersedes_version,published_by,published_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [version.id,version.tenantId,version.documentId,version.version,version.content,version.contentDigest,version.sourceRef ?? null,version.effectiveAt,version.expiresAt ?? null,version.supersedesVersion ?? null,version.publishedBy,version.publishedAt],
      );
      for (const item of items) await executor.query(
        `INSERT INTO knowledge_items(id,tenant_id,document_id,document_version,chunk_index,content,locator,permission_snapshot,status,content_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [item.id,item.tenantId,item.documentId,item.documentVersion,item.chunkIndex,item.content,item.locator,item.permissionSnapshot,item.status,item.contentDigest],
      );
    });
  }
  async searchCandidates(tenantId: string, query: string, allowedDocumentIds: string[], limit: number) {
    if (allowedDocumentIds.length === 0) return [];
    const tokens = [...new Set(query.toLocaleLowerCase().split(/[\s，。；、？！]+/).filter(Boolean).flatMap((token) => {
      if (!/[\u3400-\u9fff]/.test(token) || token.length <= 2) return [token];
      return [token, ...Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2))];
    }))].slice(0, 16);
    const documentPlaceholders = allowedDocumentIds.map((_, index) => `$${index + 2}`);
    const tokenOffset = 2 + allowedDocumentIds.length;
    const tokenClauses = tokens.map((_, index) => `lower(content) LIKE $${tokenOffset + index}`);
    const limitPlaceholder = tokenOffset + tokens.length;
    const sql = `SELECT * FROM knowledge_items WHERE tenant_id=$1 AND status='active' AND document_id IN (${documentPlaceholders.join(",")}) AND (${tokenClauses.join(" OR ")}) ORDER BY document_id,chunk_index LIMIT $${limitPlaceholder}`;
    const params = [tenantId,...allowedDocumentIds,...tokens.map((token) => `%${token}%`),limit];
    return this.database.withTenant(tenantId, async (executor) => (await executor.query(sql, params)).map(mapItem));
  }
  async listDocumentVersions(tenantId: string, documentId: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM document_versions WHERE tenant_id=$1 AND document_id=$2 ORDER BY version DESC", [tenantId,documentId]);
      return rows.map(mapVersion);
    });
  }
}
