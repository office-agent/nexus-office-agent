import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { sha256, stableJson } from "@/src/modules/pi-agent/application/manifest";
import type {
  PiModelAuthorization,
  PiModelAuthorizationInput,
  PiModelDataClassification,
  PiModelProvider,
  PiModelProviderEvent,
  PiModelRoute,
  PiModelRouteDraft,
  PiModelRouteStore,
  PiModelRouteSummary,
  PiModelUsageInput,
  PiModelUsageRecord,
} from "@/src/modules/pi-agent/domain/model-contracts";

const classificationRank: Record<PiModelDataClassification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };

function validId(value: string): boolean { return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value); }
function validVersion(value: string): boolean { return /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?$/.test(value); }
function safeRoute(route: PiModelRoute): PiModelRouteSummary {
  const { tenantId, ...summary } = route;
  void tenantId;
  return structuredClone(summary);
}
function inputDigest(value: string): boolean { return /^[a-f0-9]{64}$/i.test(value); }

export type PiModelGatewayOptions = {
  store: PiModelRouteStore;
  providers?: Record<string, PiModelProvider>;
  policyVersion?: number;
  safety?: {
    assertExecutionAllowed(context: RequestContext, subject?: { modelRouteId?: string }): Promise<void>;
    consumeFault(context: RequestContext, target: "model.provider"): Promise<void>;
  };
};

export class EnterpriseModelGateway {
  readonly policyVersion: number;
  constructor(private readonly options: PiModelGatewayOptions) { this.policyVersion = options.policyVersion ?? 1; }

  async publishRoute(context: RequestContext, input: PiModelRouteDraft): Promise<PiModelRoute> {
    assertPiPermission(context, "pi:model:admin");
    validateDraft(input);
    const route: PiModelRoute = { id: randomUUID(), tenantId: context.tenantId, ...input, allowedDataClassifications: [...new Set(input.allowedDataClassifications)], fallbackRouteIds: [...new Set(input.fallbackRouteIds)], status: "pending", createdAt: new Date().toISOString() };
    await this.options.store.putRoute(route);
    return route;
  }

  async approveRoute(context: RequestContext, routeId: string, version: string): Promise<PiModelRoute> {
    assertPiPermission(context, "pi:model:admin");
    const route = await this.requireRoute(context, routeId, version);
    if (route.status === "revoked") throw new Error("PI_MODEL_ROUTE_REVOKED");
    return this.options.store.updateRoute(context, route.routeId, route.version, { status: "approved", approvedAt: new Date().toISOString() });
  }

  async revokeRoute(context: RequestContext, routeId: string, version: string): Promise<PiModelRoute> {
    assertPiPermission(context, "pi:model:admin");
    await this.requireRoute(context, routeId, version);
    return this.options.store.updateRoute(context, routeId, version, { status: "revoked", revokedAt: new Date().toISOString() });
  }

  async listRoutes(context: RequestContext): Promise<PiModelRouteSummary[]> {
    assertPiPermission(context, "pi:model:read");
    return (await this.options.store.listRoutes(context)).map(safeRoute);
  }

  async resolveRoute(context: RequestContext, routeId: string, dataClassification: PiModelDataClassification): Promise<PiModelRoute> {
    const route = await this.requireRoute(context, routeId);
    if (route.status === "revoked") throw new Error("PI_MODEL_ROUTE_REVOKED");
    if (route.status !== "approved") throw new Error("PI_MODEL_ROUTE_NOT_APPROVED");
    if (!route.allowedDataClassifications.includes(dataClassification)) throw new Error("PI_MODEL_DATA_CLASSIFICATION_DENIED");
    if (route.egress === "public" && dataClassification === "restricted") throw new Error("PI_MODEL_PUBLIC_EGRESS_RESTRICTED");
    return route;
  }

  async authorizePrompt(context: RequestContext, input: PiModelAuthorizationInput): Promise<PiModelAuthorization> {
    assertPiPermission(context, "pi:model:read");
    await this.options.safety?.assertExecutionAllowed(context, { modelRouteId: input.routeId });
    if (!inputDigest(input.promptDigest)) throw new Error("PI_MODEL_PROMPT_DIGEST_INVALID");
    if (!Number.isInteger(input.inputTokens) || input.inputTokens < 0 || !Number.isInteger(input.outputTokens) || input.outputTokens < 0) throw new Error("PI_MODEL_TOKEN_COUNT_INVALID");
    const route = await this.options.store.getRoute(context, input.routeId);
    if (!route) return { allowed: false, reasonCode: "route_not_found", policyVersion: this.policyVersion };
    if (route.status === "revoked") return { allowed: false, reasonCode: "route_revoked", policyVersion: this.policyVersion };
    if (route.status !== "approved") return { allowed: false, reasonCode: "route_not_found", policyVersion: this.policyVersion };
    if (!route.allowedDataClassifications.includes(input.dataClassification)) return { allowed: false, route: safeRoute(route), reasonCode: "data_classification_denied", policyVersion: this.policyVersion };
    if (route.egress === "public" && input.dataClassification === "restricted") return { allowed: false, route: safeRoute(route), reasonCode: "public_egress_restricted", policyVersion: this.policyVersion };
    if (input.inputTokens > route.maxInputTokens || input.outputTokens > route.maxOutputTokens) return { allowed: false, route: safeRoute(route), reasonCode: "token_budget_exceeded", policyVersion: this.policyVersion };
    return { allowed: true, route: safeRoute(route), reasonCode: "approved", policyVersion: this.policyVersion };
  }

  async *streamCompletion(context: RequestContext, input: { routeId: string; dataClassification: PiModelDataClassification; promptDigest: string; inputTokens: number; maxOutputTokens?: number; traceId?: string }): AsyncIterable<PiModelProviderEvent> {
    const authorization = await this.authorizePrompt(context, { routeId: input.routeId, dataClassification: input.dataClassification, inputTokens: input.inputTokens, outputTokens: input.maxOutputTokens ?? 0, promptDigest: input.promptDigest, traceId: input.traceId });
    if (!authorization.allowed || !authorization.route) throw new Error(`PI_MODEL_AUTHORIZATION_DENIED:${authorization.reasonCode ?? "unknown"}`);
    const route = await this.resolveRoute(context, input.routeId, input.dataClassification);
    const provider = this.options.providers?.[route.provider];
    if (!provider) throw new Error("PI_MODEL_GATEWAY_NOT_READY");
    await this.options.safety?.consumeFault(context, "model.provider");
    let outputTokens = 0;
    const started = Date.now();
    for await (const event of provider.stream({ route, authorization, promptDigest: input.promptDigest, inputTokens: input.inputTokens, maxOutputTokens: input.maxOutputTokens ?? route.maxOutputTokens, traceId: input.traceId ?? context.traceId })) {
      if (event.type === "delta" || event.type === "completed") outputTokens = Math.max(outputTokens, event.outputTokens);
      yield event;
      if (event.type === "completed" || event.type === "failed") {
        await this.recordUsage(context, { usageId: randomUUID(), routeId: route.routeId, provider: route.provider, model: route.model, dataClassification: input.dataClassification, inputTokens: input.inputTokens, outputTokens, latencyMs: event.latencyMs ?? Date.now() - started, status: event.type === "completed" ? "succeeded" : "failed", idempotencyKey: `model:${input.traceId ?? context.traceId}`, traceId: input.traceId ?? context.traceId });
      }
    }
  }

  async recordUsage(context: RequestContext, input: PiModelUsageInput): Promise<PiModelUsageRecord> {
    assertPiPermission(context, "pi:model:usage");
    if (!inputDigest(input.traceId) && input.traceId.length > 128) throw new Error("PI_MODEL_TRACE_INVALID");
    if (![input.inputTokens, input.outputTokens, input.latencyMs].every((value) => Number.isInteger(value) && value >= 0)) throw new Error("PI_MODEL_USAGE_INVALID");
    const route = await this.requireRoute(context, input.routeId);
    if (route.provider !== input.provider || route.model !== input.model) throw new Error("PI_MODEL_ROUTE_VERSION_CONFLICT");
    const costMicros = Math.ceil(input.inputTokens * route.inputCostMicrosPerMillion / 1_000_000 + input.outputTokens * route.outputCostMicrosPerMillion / 1_000_000);
    const record: PiModelUsageRecord = { ...input, tenantId: context.tenantId, actorId: context.actorId, costMicros, createdAt: new Date().toISOString() };
    return (await this.options.store.appendUsage(record)).record;
  }

  async listUsage(context: RequestContext, limit = 100): Promise<PiModelUsageRecord[]> {
    assertPiPermission(context, "pi:usage:read");
    return this.options.store.listUsage(context, Math.min(Math.max(limit, 1), 500));
  }

  async fallback(context: RequestContext, routeId: string, dataClassification: PiModelDataClassification): Promise<PiModelRouteSummary | null> {
    await this.options.safety?.assertExecutionAllowed(context, { modelRouteId: routeId });
    const route = await this.requireRoute(context, routeId);
    for (const fallbackId of route.fallbackRouteIds) {
      const candidate = await this.options.store.getRoute(context, fallbackId);
      if (candidate?.status === "approved" && candidate.allowedDataClassifications.includes(dataClassification) && !(candidate.egress === "public" && dataClassification === "restricted")) return safeRoute(candidate);
    }
    return null;
  }

  async cancelRequest(context: RequestContext, providerId: string, traceId: string): Promise<void> {
    assertPiPermission(context, "pi:model:cancel");
    await this.options.providers?.[providerId]?.cancel?.(traceId);
  }

  private async requireRoute(context: RequestContext, routeId: string, version?: string): Promise<PiModelRoute> {
    const route = await this.options.store.getRoute(context, routeId, version);
    if (!route) throw new Error("PI_MODEL_ROUTE_NOT_FOUND");
    return route;
  }
}

function validateDraft(input: PiModelRouteDraft): void {
  if (!validId(input.routeId)) throw new Error("PI_MODEL_ROUTE_ID_INVALID");
  if (!validVersion(input.version)) throw new Error("PI_MODEL_ROUTE_VERSION_INVALID");
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(input.provider) || !/^[\w./:-]{1,128}$/.test(input.model)) throw new Error("PI_MODEL_PROVIDER_INVALID");
  if (!/^[a-z0-9-]{2,32}$/.test(input.region)) throw new Error("PI_MODEL_REGION_INVALID");
  if (!Array.isArray(input.allowedDataClassifications) || input.allowedDataClassifications.length === 0) throw new Error("PI_MODEL_CLASSIFICATION_POLICY_INVALID");
  if (input.egress === "public" && input.allowedDataClassifications.includes("restricted")) throw new Error("PI_MODEL_PUBLIC_EGRESS_RESTRICTED");
  if (![input.maxInputTokens, input.maxOutputTokens].every((value) => Number.isInteger(value) && value > 0 && value <= 10_000_000)) throw new Error("PI_MODEL_TOKEN_LIMIT_INVALID");
  if (![input.inputCostMicrosPerMillion, input.outputCostMicrosPerMillion].every((value) => Number.isInteger(value) && value >= 0 && value <= 10_000_000_000)) throw new Error("PI_MODEL_COST_INVALID");
  if (input.fallbackRouteIds.some((id) => !validId(id))) throw new Error("PI_MODEL_FALLBACK_INVALID");
  if (sha256(stableJson([...new Set(input.allowedDataClassifications)].sort())) === "") throw new Error("PI_MODEL_CLASSIFICATION_POLICY_INVALID");
  for (let index = 1; index < input.allowedDataClassifications.length; index += 1) if (classificationRank[input.allowedDataClassifications[index]] < classificationRank[input.allowedDataClassifications[index - 1]]) throw new Error("PI_MODEL_CLASSIFICATION_POLICY_INVALID");
}
