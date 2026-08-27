export type DataClassification = "public" | "internal" | "confidential" | "restricted";

export type DocumentAccess = {
  ownerId: string;
  classification: DataClassification;
  allowedUserIds: string[];
  allowedRoleCodes: string[];
  projectIds: string[];
  agentIndexingAllowed: boolean;
};

export type Document = {
  id: string;
  tenantId: string;
  title: string;
  ownerId: string;
  classification: DataClassification;
  status: "draft" | "published" | "archived";
  currentVersion: number;
  access: DocumentAccess;
  version: number;
};

export type DocumentVersion = {
  id: string;
  tenantId: string;
  documentId: string;
  version: number;
  content: string;
  contentDigest: string;
  sourceRef?: string;
  effectiveAt: string;
  expiresAt?: string;
  supersedesVersion?: number;
  publishedBy: string;
  publishedAt: string;
};

export type KnowledgeItem = {
  id: string;
  tenantId: string;
  documentId: string;
  documentVersion: number;
  chunkIndex: number;
  content: string;
  locator: string;
  permissionSnapshot: DocumentAccess;
  status: "active" | "invalidated";
  contentDigest: string;
};

export type KnowledgeCitation = {
  id: string;
  documentId: string;
  documentVersion: number;
  title: string;
  excerpt: string;
  locator: string;
  sourceRef?: string;
  effectiveAt: string;
  expiresAt?: string;
  classification: DataClassification;
  accessBasis: "owner" | "explicit_user" | "role" | "project" | "classification";
  retrievedAt: string;
  untrustedContent: true;
};
