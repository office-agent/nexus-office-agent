import { createHash } from "node:crypto";
import type { KnowledgeRepository } from "@/src/modules/knowledge/application/contracts";
import type { Document, DocumentVersion, KnowledgeItem } from "@/src/modules/knowledge/domain/document";
import { DEMO_MANAGER_ID, DEMO_PROJECT_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

export const DEMO_DOCUMENT_ID = "85000000-0000-4000-8000-000000000001";

function score(query: string, content: string): number {
  const tokens = [...new Set(query.toLocaleLowerCase().split(/[\s，。；、？！]+/).filter(Boolean).flatMap((token) => {
    if (!/[\u3400-\u9fff]/.test(token) || token.length <= 2) return [token];
    return [token, ...Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2))];
  }))];
  const haystack = content.toLocaleLowerCase();
  return tokens.reduce((sum, token) => sum + (haystack.includes(token) ? Math.max(1, token.length) : 0), 0);
}

export class InMemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly documents = new Map<string, Document>();
  private readonly versions = new Map<string, DocumentVersion>();
  private readonly items = new Map<string, KnowledgeItem>();

  constructor(seed = true) { if (seed) this.seed(); }

  async getDocument(tenantId: string, id: string): Promise<Document | null> {
    const document = this.documents.get(id);
    return document?.tenantId === tenantId ? structuredClone(document) : null;
  }

  async getDocumentVersion(tenantId: string, documentId: string, version: number): Promise<DocumentVersion | null> {
    const item = this.versions.get(`${documentId}:${version}`);
    return item?.tenantId === tenantId ? structuredClone(item) : null;
  }

  async listPublishedDocuments(tenantId: string): Promise<Document[]> {
    return [...this.documents.values()].filter((item) => item.tenantId === tenantId && item.status === "published").map((item) => structuredClone(item));
  }

  async savePublishedDocument(document: Document, version: DocumentVersion, items: KnowledgeItem[]): Promise<void> {
    for (const [id, item] of this.items.entries()) {
      if (item.tenantId === document.tenantId && item.documentId === document.id && item.status === "active") {
        this.items.set(id, { ...item, status: "invalidated" });
      }
    }
    this.documents.set(document.id, structuredClone(document));
    this.versions.set(`${document.id}:${version.version}`, structuredClone(version));
    for (const item of items) this.items.set(item.id, structuredClone(item));
  }

  async searchCandidates(tenantId: string, query: string, allowedDocumentIds: string[], limit: number): Promise<KnowledgeItem[]> {
    const allowed = new Set(allowedDocumentIds);
    return [...this.items.values()]
      .filter((item) => item.tenantId === tenantId && item.status === "active" && allowed.has(item.documentId))
      .map((item) => ({ item, score: score(query, item.content) }))
      .filter(({ score: itemScore }) => itemScore > 0)
      .sort((left, right) => right.score - left.score || left.item.chunkIndex - right.item.chunkIndex)
      .slice(0, limit)
      .map(({ item }) => structuredClone(item));
  }

  async listDocumentVersions(tenantId: string, documentId: string): Promise<DocumentVersion[]> {
    return [...this.versions.values()]
      .filter((item) => item.tenantId === tenantId && item.documentId === documentId)
      .sort((left, right) => right.version - left.version)
      .map((item) => structuredClone(item));
  }

  private seed() {
    const content = "客户数据按公开、内部、机密、受限四级管理。受限数据不得进入公共模型。生产数据导出必须由数据负责人和安全负责人共同批准，并保留审计记录。";
    const access = {
      ownerId: DEMO_MANAGER_ID, classification: "confidential" as const,
      allowedUserIds: [], allowedRoleCodes: ["enterprise_manager"], projectIds: [DEMO_PROJECT_ID], agentIndexingAllowed: true,
    };
    const document: Document = {
      id: DEMO_DOCUMENT_ID, tenantId: DEMO_TENANT_ID, title: "客户数据安全分级制度",
      ownerId: DEMO_MANAGER_ID, classification: "confidential", status: "published", currentVersion: 1,
      access, version: 1,
    };
    const contentDigest = createHash("sha256").update(content).digest("hex");
    const version: DocumentVersion = {
      id: "85100000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, documentId: document.id,
      version: 1, content, contentDigest, sourceRef: "policy:customer-data-security", effectiveAt: "2026-07-01T00:00:00.000Z",
      publishedBy: DEMO_MANAGER_ID, publishedAt: "2026-07-01T00:00:00.000Z",
    };
    const item: KnowledgeItem = {
      id: "85200000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, documentId: document.id,
      documentVersion: 1, chunkIndex: 0, content, locator: "paragraph:1", permissionSnapshot: access,
      status: "active", contentDigest,
    };
    this.documents.set(document.id, document);
    this.versions.set(`${document.id}:1`, version);
    this.items.set(item.id, item);
  }
}

const runtime = globalThis as typeof globalThis & { __nexusKnowledgeRepository?: InMemoryKnowledgeRepository; __nexusKnowledgeRepositoryVersion?: number };
export function getDevelopmentKnowledgeRepository() {
  if (runtime.__nexusKnowledgeRepositoryVersion !== 1) {
    runtime.__nexusKnowledgeRepository = new InMemoryKnowledgeRepository();
    runtime.__nexusKnowledgeRepositoryVersion = 1;
  }
  return runtime.__nexusKnowledgeRepository!;
}
