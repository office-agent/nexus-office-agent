import type { RequestContext, DataScope } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import { sha256, stableJson } from "@/src/modules/pi-agent/application/manifest";
import { getPiProfile, PI_PROFILES } from "@/src/modules/pi-agent/domain/profiles";
import type { PiProfileId, PiRiskLevel } from "@/src/modules/pi-agent/domain/contracts";
import type { AgentProfileRegistry, PiAgentProfileSnapshot, PiDelegationBudget, PiDelegationPolicy } from "@/src/modules/pi-agent/domain/profile-contracts";

const RISK_BY_NUMBER: Record<number, PiRiskLevel> = { 0: "R0", 1: "R1", 2: "R2", 3: "R3", 4: "R4" };
const BUILTIN_IDS = Object.keys(PI_PROFILES) as PiProfileId[];
const DEFAULT_BUDGET: PiDelegationBudget = { maxDurationMs: 10 * 60 * 1000, maxOutputBytes: 2_000_000, maxTokens: 40_000, maxChildRuns: 4 };

function clone<T>(value: T): T { return structuredClone(value); }

function profileId(value: unknown): PiProfileId {
  if (typeof value !== "string" || !BUILTIN_IDS.includes(value as PiProfileId)) throw new Error("PI_PROFILE_INVALID");
  return value as PiProfileId;
}

function risk(value: unknown, fallback: number): PiRiskLevel {
  const result = typeof value === "string" ? value : RISK_BY_NUMBER[Number(value)];
  if (result && ["R0", "R1", "R2", "R3", "R4"].includes(result)) return result as PiRiskLevel;
  return RISK_BY_NUMBER[fallback] ?? "R2";
}

function budget(value: unknown, fallback = DEFAULT_BUDGET): PiDelegationBudget {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result = {
    maxDurationMs: Number(input.maxDurationMs ?? fallback.maxDurationMs),
    maxOutputBytes: Number(input.maxOutputBytes ?? fallback.maxOutputBytes),
    maxTokens: Number(input.maxTokens ?? fallback.maxTokens),
    maxChildRuns: Number(input.maxChildRuns ?? fallback.maxChildRuns),
  };
  if (!Number.isSafeInteger(result.maxDurationMs) || result.maxDurationMs < 1 || result.maxDurationMs > 60 * 60 * 1000) throw new Error("PI_PROFILE_BUDGET_INVALID");
  if (!Number.isSafeInteger(result.maxOutputBytes) || result.maxOutputBytes < 1 || result.maxOutputBytes > 50_000_000) throw new Error("PI_PROFILE_BUDGET_INVALID");
  if (!Number.isSafeInteger(result.maxTokens) || result.maxTokens < 1 || result.maxTokens > 1_000_000) throw new Error("PI_PROFILE_BUDGET_INVALID");
  if (!Number.isSafeInteger(result.maxChildRuns) || result.maxChildRuns < 0 || result.maxChildRuns > 32) throw new Error("PI_PROFILE_BUDGET_INVALID");
  return result;
}

function delegationPolicy(base: PiProfileId, value?: unknown, canExecuteSandbox = getPiProfile(base).canExecuteSandbox): PiDelegationPolicy {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const allowedProfiles = Array.isArray(input.allowedProfiles) ? input.allowedProfiles.map(profileId) : [base];
  const defaultCanDelegate = canExecuteSandbox && base !== "release";
  const result: PiDelegationPolicy = {
    maxDepth: Number(input.maxDepth ?? (defaultCanDelegate ? 2 : 0)),
    maxConcurrentChildren: Number(input.maxConcurrentChildren ?? (defaultCanDelegate ? 2 : 0)),
    allowedProfiles: [...new Set(allowedProfiles)],
    budget: budget(input.budget, { ...DEFAULT_BUDGET, maxChildRuns: defaultCanDelegate ? DEFAULT_BUDGET.maxChildRuns : 0 }),
  };
  if (!Number.isSafeInteger(result.maxDepth) || result.maxDepth < 0 || result.maxDepth > 8) throw new Error("PI_PROFILE_DELEGATION_POLICY_INVALID");
  if (!Number.isSafeInteger(result.maxConcurrentChildren) || result.maxConcurrentChildren < 0 || result.maxConcurrentChildren > 16) throw new Error("PI_PROFILE_DELEGATION_POLICY_INVALID");
  if (result.maxDepth === 0 && result.maxConcurrentChildren > 0) throw new Error("PI_PROFILE_DELEGATION_POLICY_INVALID");
  return result;
}

function snapshotFrom(baseId: PiProfileId, overrides?: Record<string, unknown>): PiAgentProfileSnapshot {
  const base = getPiProfile(baseId);
  const canExecuteSandbox = overrides?.canExecuteSandbox === false ? false : base.canExecuteSandbox;
  const allowedTools = Array.isArray(overrides?.allowedTools) ? overrides.allowedTools.filter((tool): tool is string => typeof tool === "string") : [...base.allowedTools];
  if (allowedTools.some((tool) => !base.allowedTools.includes(tool))) throw new Error("PI_PROFILE_TOOL_ESCALATION");
  const dataScopes: DataScope[] = Array.isArray(overrides?.allowedDataScopes) ? overrides.allowedDataScopes as DataScope[] : [{ type: "tenant" }];
  const snapshot = {
    id: base.id,
    version: Number(overrides?.version ?? base.version),
    description: typeof overrides?.description === "string" ? overrides.description.slice(0, 500) : base.description,
    allowedTools: [...new Set(allowedTools)].sort(),
    allowedDataScopes: clone(dataScopes),
    maxRiskLevel: risk(overrides?.maxRiskLevel, base.maxRiskLevel),
    networkPolicy: overrides?.networkPolicy === "none" || overrides?.networkPolicy === "allowlist" || overrides?.networkPolicy === "restricted" ? overrides.networkPolicy : base.networkPolicy,
    canModifyWorkspace: overrides?.canModifyWorkspace === false ? false : base.canModifyWorkspace,
    canExecuteSandbox,
    delegationPolicy: delegationPolicy(base.id, overrides?.delegationPolicy, canExecuteSandbox),
  } satisfies Omit<PiAgentProfileSnapshot, "digest">;
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) throw new Error("PI_PROFILE_VERSION_INVALID");
  if (!snapshot.canExecuteSandbox && snapshot.delegationPolicy.maxConcurrentChildren > 0) throw new Error("PI_PROFILE_DELEGATION_POLICY_INVALID");
  return { ...snapshot, digest: sha256(stableJson(snapshot)) };
}

export class StaticAgentProfileRegistry implements AgentProfileRegistry {
  private readonly profiles: Map<PiProfileId, PiAgentProfileSnapshot>;

  constructor(overrides: Partial<Record<PiProfileId, Record<string, unknown>>> = {}) {
    this.profiles = new Map(BUILTIN_IDS.map((id) => [id, snapshotFrom(id, overrides[id])]));
  }

  async resolveProfile(_context: RequestContext, profileIdValue: PiProfileId): Promise<PiAgentProfileSnapshot> {
    const profile = this.profiles.get(profileIdValue);
    if (!profile) throw new Error("PI_PROFILE_NOT_FOUND");
    return clone(profile);
  }

  async listProfiles(): Promise<PiAgentProfileSnapshot[]> {
    return [...this.profiles.values()].map(clone);
  }
}

export class FailClosedAgentProfileRegistry implements AgentProfileRegistry {
  async resolveProfile(): Promise<PiAgentProfileSnapshot> { throw new Error("PI_PROFILE_REGISTRY_UNAVAILABLE"); }
  async listProfiles(): Promise<PiAgentProfileSnapshot[]> { throw new Error("PI_PROFILE_REGISTRY_UNAVAILABLE"); }
}

export class PostgresAgentProfileRegistry implements AgentProfileRegistry {
  constructor(private readonly database: TransactionalDatabase, private readonly fallback = new StaticAgentProfileRegistry()) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.database.withTenant(context.tenantId, work);
  }

  async resolveProfile(context: RequestContext, profileIdValue: PiProfileId): Promise<PiAgentProfileSnapshot> {
    const rows = await this.scoped(context, (db) => db.query<Record<string, unknown>>(
      "SELECT id,version,description,policy,status FROM agent_profiles WHERE tenant_id=$1 AND id=$2 AND status='approved' ORDER BY version DESC LIMIT 1",
      [context.tenantId, profileIdValue],
    ));
    if (!rows[0]) return this.fallback.resolveProfile(context, profileIdValue);
    const raw = rows[0].policy;
    const policy = typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return snapshotFrom(profileIdValue, { ...policy, version: Number(rows[0].version), description: String(rows[0].description ?? "") });
  }

  async listProfiles(context: RequestContext): Promise<PiAgentProfileSnapshot[]> {
    const result = await Promise.all(BUILTIN_IDS.map((id) => this.resolveProfile(context, id)));
    return result;
  }
}
