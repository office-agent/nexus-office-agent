import type { RequestContext } from "@/src/platform/context/request-context";

export const PROJECT_TO_ACT_DOCUMENT_KINDS = ["overview", "progress", "features", "versions", "acceptance"] as const;
export type ProjectToActDocumentKind = (typeof PROJECT_TO_ACT_DOCUMENT_KINDS)[number];
export type AgentDevelopmentStatus = "requirements_archived" | "in_development" | "testing" | "ready_to_deliver" | "delivered";

export type ProjectToActDocument = {
  id: string;
  projectId: string;
  kind: ProjectToActDocumentKind;
  path: string;
  revision: number;
  content: string;
  digest: string;
  archivedAt: string;
};

export type AgentDevelopmentVersion = {
  id: string;
  projectId: string;
  name: string;
  fromCommit: string;
  toCommit: string;
  diffContent: string;
  diffDigest: string;
  features: string[];
  createdBy: string;
  createdAt: string;
};

export type AgentDevelopmentFunctionalTest = {
  id: string;
  projectId: string;
  versionId: string;
  name: string;
  cases: string[];
  result: "passed" | "failed";
  evidence: string;
  evidenceDigest: string;
  createdBy: string;
  createdAt: string;
};

export type AgentDevelopmentDelivery = {
  id: string;
  projectId: string;
  manifestDigest: string;
  documentDigests: Record<ProjectToActDocumentKind, string>;
  versionIds: string[];
  testIds: string[];
  createdBy: string;
  createdAt: string;
};

export type AgentDevelopmentProject = {
  id: string;
  tenantId: string;
  createdBy: string;
  code: string;
  name: string;
  owner: string;
  objective: string;
  scope: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  status: AgentDevelopmentStatus;
  inputDigest: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  documents: ProjectToActDocument[];
  versions: AgentDevelopmentVersion[];
  tests: AgentDevelopmentFunctionalTest[];
  delivery?: AgentDevelopmentDelivery;
};

export type AgentDevelopmentProjectSeed = Omit<AgentDevelopmentProject, "documents" | "versions" | "tests" | "delivery">;

export interface AgentDevelopmentStore {
  list(context: RequestContext): Promise<AgentDevelopmentProject[]>;
  find(context: RequestContext, projectId: string): Promise<AgentDevelopmentProject | null>;
  findProjectByIdempotency(context: RequestContext, idempotencyKey: string): Promise<AgentDevelopmentProject | null>;
  create(context: RequestContext, project: AgentDevelopmentProjectSeed, documents: ProjectToActDocument[], idempotencyKey: string): Promise<{ project: AgentDevelopmentProject; created: boolean }>;
  appendVersion(context: RequestContext, projectId: string, expectedVersion: number, item: AgentDevelopmentVersion, documents: ProjectToActDocument[], idempotencyKey: string, status: AgentDevelopmentStatus): Promise<AgentDevelopmentProject>;
  appendTest(context: RequestContext, projectId: string, expectedVersion: number, item: AgentDevelopmentFunctionalTest, documents: ProjectToActDocument[], idempotencyKey: string, status: AgentDevelopmentStatus): Promise<AgentDevelopmentProject>;
  createDelivery(context: RequestContext, projectId: string, expectedVersion: number, item: AgentDevelopmentDelivery, documents: ProjectToActDocument[], idempotencyKey: string): Promise<AgentDevelopmentProject>;
}

export type AgentDevelopmentSkillRecommendation = {
  name: string;
  stage: "handoff" | "development" | "testing" | "delivery" | "throughout";
  purpose: string;
  required: boolean;
};
