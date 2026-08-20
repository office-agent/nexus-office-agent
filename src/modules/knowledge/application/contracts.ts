import type { Document, DocumentVersion, KnowledgeItem } from "@/src/modules/knowledge/domain/document";

export interface KnowledgeRepository {
  getDocument(tenantId: string, id: string): Promise<Document | null>;
  listPublishedDocuments(tenantId: string): Promise<Document[]>;
  savePublishedDocument(document: Document, version: DocumentVersion, items: KnowledgeItem[]): Promise<void>;
  searchCandidates(tenantId: string, query: string, allowedDocumentIds: string[], limit: number): Promise<KnowledgeItem[]>;
  listDocumentVersions(tenantId: string, documentId: string): Promise<DocumentVersion[]>;
}
