import type { RequestContext } from "@/src/platform/context/request-context";

export type PiModelDataClassification = "public" | "internal" | "confidential" | "restricted";
export type PiModelEgress = "private" | "public" | "local";
export type PiModelRouteStatus = "pending" | "approved" | "revoked";

export type PiModelRoute = {
  id: string;
  tenantId: string;
  routeId: string;
  version: string;
  provider: string;
  model: string;
  region: string;
  egress: PiModelEgress;
  allowedDataClassifications: PiModelDataClassification[];
  fallbackRouteIds: string[];
  maxInputTokens: number;
  maxOutputTokens: number;
  inputCostMicrosPerMillion: number;
  outputCostMicrosPerMillion: number;
  status: PiModelRouteStatus;
  createdAt: string;
  approvedAt?: string;
  revokedAt?: string;
};

export type PiModelRouteSummary = Omit<PiModelRoute, "tenantId">;

export type PiModelRouteDraft = {
  routeId: string;
  version: string;
  provider: string;
  model: string;
  region: string;
  egress: PiModelEgress;
  allowedDataClassifications: PiModelDataClassification[];
  fallbackRouteIds: string[];
  maxInputTokens: number;
  maxOutputTokens: number;
  inputCostMicrosPerMillion: number;
  outputCostMicrosPerMillion: number;
};

export type PiModelAuthorizationInput = {
  routeId: string;
  dataClassification: PiModelDataClassification;
  inputTokens: number;
  outputTokens: number;
  promptDigest: string;
  traceId?: string;
};

export type PiModelAuthorization = {
  allowed: boolean;
  route?: PiModelRouteSummary;
  reasonCode?: "approved" | "route_not_found" | "data_classification_denied" | "token_budget_exceeded" | "public_egress_restricted" | "route_revoked";
  policyVersion: number;
};

export type PiModelUsageInput = {
  usageId: string;
  routeId: string;
  provider: string;
  model: string;
  dataClassification: PiModelDataClassification;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: "succeeded" | "failed" | "cancelled" | "blocked";
  idempotencyKey: string;
  workspaceId?: string;
  sessionId?: string;
  runId?: string;
  traceId: string;
};

export type PiModelUsageRecord = PiModelUsageInput & {
  tenantId: string;
  actorId: string;
  costMicros: number;
  createdAt: string;
};

export type PiModelProviderRequest = {
  route: PiModelRoute;
  authorization: PiModelAuthorization;
  promptDigest: string;
  inputTokens: number;
  maxOutputTokens: number;
  traceId: string;
  signal?: AbortSignal;
};

export type PiModelProviderEvent =
  | { type: "delta"; outputDigest: string; outputTokens: number }
  | { type: "completed"; outputDigest: string; outputTokens: number; latencyMs: number }
  | { type: "failed"; errorCode: string; latencyMs: number };

export interface PiModelProvider {
  stream(input: PiModelProviderRequest): AsyncIterable<PiModelProviderEvent>;
  cancel?(traceId: string): Promise<void>;
}

export interface PiModelRouteStore {
  putRoute(route: PiModelRoute): Promise<void>;
  getRoute(context: RequestContext, routeId: string, version?: string): Promise<PiModelRoute | null>;
  listRoutes(context: RequestContext): Promise<PiModelRoute[]>;
  updateRoute(context: RequestContext, routeId: string, version: string, patch: Partial<Pick<PiModelRoute, "status" | "approvedAt" | "revokedAt">>): Promise<PiModelRoute>;
  appendUsage(record: PiModelUsageRecord): Promise<{ record: PiModelUsageRecord; created: boolean }>;
  listUsage(context: RequestContext, limit?: number): Promise<PiModelUsageRecord[]>;
}
