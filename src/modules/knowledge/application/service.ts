import { createHash, randomUUID } from "node:crypto";
import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { KnowledgeRepository } from "@/src/modules/knowledge/application/contracts";
import type { Document, DocumentAccess, DocumentVersion, KnowledgeCitation, KnowledgeItem } from "@/src/modules/knowledge/domain/document";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function chunks(content: string): string[] {
  const paragraphs = content.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const output: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 900) output.push(paragraph);
    else for (let offset = 0; offset < paragraph.length; offset += 850) output.push(paragraph.slice(offset, offset + 900));
  }
  return output.length ? output : [content.trim()];
}

function explicitlyAllowed(context: RequestContext, access: DocumentAccess): boolean {
  if (access.ownerId === context.actorId || access.allowedUserIds.includes(context.actorId)) return true;
  if (access.classification === "restricted") return false;
  if (access.allowedRoleCodes.some((role) => context.roles.includes(role))) return true;
  return access.projectIds.some((projectId) => context.dataScopes.some((scope) => scope.type === "project" && scope.projectIds.includes(projectId)));
}

function canRead(context: RequestContext, document: Document, forAgent: boolean): boolean {
  if (forAgent && !document.access.agentIndexingAllowed) return false;
  const policy = evaluateAccess({
    context,
    action: "read",
    resource: {
      tenantId: document.tenantId,
      type: "document",
      id: document.id,
      ownerId: document.ownerId,
      projectId: document.access.projectIds[0],
      classification: document.classification,
      state: document.status,
    },
  });
  if (!policy.allowed || document.status !== "published") return false;
  if (document.classification === "public" || document.classification === "internal") return true;
  return explicitlyAllowed(context, document.access);
}

export class KnowledgeService {
  constructor(private readonly repository: KnowledgeRepository) {}

  async listDocuments(context: RequestContext, forAgent = false) {
    const documents = await this.repository.listPublishedDocuments(context.tenantId);
    return documents.filter((document) => canRead(context, document, forAgent));
  }

  async publish(context: RequestContext, input: {
    documentId?: string;
    title: string;
    content: string;
    classification: Document["classification"];
    allowedUserIds?: string[];
    allowedRoleCodes?: string[];
    projectIds?: string[];
    agentIndexingAllowed?: boolean;
    sourceRef?: string;
    effectiveAt?: string;
    expiresAt?: string;
  }): Promise<{ document: Document; version: DocumentVersion; itemCount: number }> {
    if (!input.content.trim()) throw new Error("DOCUMENT_CONTENT_REQUIRED");
    const current = input.documentId ? await this.repository.getDocument(context.tenantId, input.documentId) : null;
    if (input.documentId && !current) throw new Error("DOCUMENT_NOT_FOUND");
    const policy = evaluateAccess({
      context, action: current ? "update" : "create",
      resource: { tenantId: context.tenantId, type: "document", id: current?.id ?? "new", ownerId: current?.ownerId ?? context.actorId },
    });
    if (!policy.allowed) throw new Error(`POLICY_DENIED:${policy.reason}`);
    if (current && current.ownerId !== context.actorId && !context.permissions.includes("document:admin") && !context.permissions.includes("*")) {
      throw new Error("POLICY_DENIED:DOCUMENT_OWNER_REQUIRED");
    }
    const nextVersion = (current?.currentVersion ?? 0) + 1;
    const access: DocumentAccess = {
      ownerId: current?.ownerId ?? context.actorId,
      classification: input.classification,
      allowedUserIds: [...new Set(input.allowedUserIds ?? [])],
      allowedRoleCodes: [...new Set(input.allowedRoleCodes ?? [])],
      projectIds: [...new Set(input.projectIds ?? [])],
      agentIndexingAllowed: input.agentIndexingAllowed ?? input.classification !== "restricted",
    };
    const document: Document = current ? {
      ...current, title: input.title, classification: input.classification, status: "published",
      currentVersion: nextVersion, access, version: current.version + 1,
    } : {
      id: randomUUID(), tenantId: context.tenantId, title: input.title, ownerId: context.actorId,
      classification: input.classification, status: "published", currentVersion: nextVersion,
      access, version: 1,
    };
    const content = input.content.trim();
    const version: DocumentVersion = {
      id: randomUUID(), tenantId: context.tenantId, documentId: document.id, version: nextVersion,
      content, contentDigest: digest(content), sourceRef: input.sourceRef,
      effectiveAt: input.effectiveAt ?? new Date().toISOString(), expiresAt: input.expiresAt,
      supersedesVersion: current?.currentVersion, publishedBy: context.actorId, publishedAt: new Date().toISOString(),
    };
    const items: KnowledgeItem[] = chunks(content).map((chunk, index) => ({
      id: randomUUID(), tenantId: context.tenantId, documentId: document.id, documentVersion: nextVersion,
      chunkIndex: index, content: chunk, locator: `paragraph:${index + 1}`, permissionSnapshot: structuredClone(access),
      status: "active", contentDigest: digest(chunk),
    }));
    await this.repository.savePublishedDocument(document, version, items);
    return { document, version, itemCount: items.length };
  }

  async search(context: RequestContext, query: string, options: { forAgent?: boolean; limit?: number } = {}): Promise<KnowledgeCitation[]> {
    const normalized = query.trim();
    if (!normalized) throw new Error("KNOWLEDGE_QUERY_REQUIRED");
    const forAgent = options.forAgent ?? true;
    const heads = await this.repository.listPublishedDocuments(context.tenantId);
    const allowedIds = heads.filter((document) => canRead(context, document, forAgent)).map(({ id }) => id);
    if (allowedIds.length === 0) return [];
    const candidates = await this.repository.searchCandidates(context.tenantId, normalized, allowedIds, Math.min(options.limit ?? 8, 20));
    const documents = new Map(heads.map((document) => [document.id, document]));
    const retrievedAt = new Date().toISOString();
    const citations: KnowledgeCitation[] = [];
    for (const item of candidates) {
      const latest = await this.repository.getDocument(context.tenantId, item.documentId);
      const prefiltered = documents.get(item.documentId);
      if (!latest || !prefiltered || latest.version !== prefiltered.version) continue;
      if (!canRead(context, latest, forAgent) || latest.currentVersion !== item.documentVersion || item.status !== "active") continue;
      citations.push({
        id: item.id, documentId: item.documentId, documentVersion: item.documentVersion,
        title: latest.title, excerpt: item.content.slice(0, 320), locator: item.locator,
        classification: latest.classification, retrievedAt, untrustedContent: true,
      });
    }
    return citations;
  }

  async versions(context: RequestContext, documentId: string) {
    const document = await this.repository.getDocument(context.tenantId, documentId);
    if (!document || !canRead(context, document, false)) throw new Error("DOCUMENT_NOT_FOUND");
    return this.repository.listDocumentVersions(context.tenantId, documentId);
  }
}
