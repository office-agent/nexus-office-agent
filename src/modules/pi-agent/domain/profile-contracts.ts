import type { RequestContext, DataScope } from "@/src/platform/context/request-context";
import type { PiProfileId, PiRiskLevel } from "@/src/modules/pi-agent/domain/contracts";

export type PiDelegationBudget = {
  maxDurationMs: number;
  maxOutputBytes: number;
  maxTokens: number;
  maxChildRuns: number;
};

export type PiDelegationPolicy = {
  maxDepth: number;
  maxConcurrentChildren: number;
  allowedProfiles: PiProfileId[];
  budget: PiDelegationBudget;
};

export type PiAgentProfileSnapshot = {
  id: PiProfileId;
  version: number;
  digest: string;
  description: string;
  allowedTools: string[];
  allowedDataScopes: DataScope[];
  maxRiskLevel: PiRiskLevel;
  networkPolicy: "none" | "allowlist" | "restricted";
  canModifyWorkspace: boolean;
  canExecuteSandbox: boolean;
  delegationPolicy: PiDelegationPolicy;
};

export interface AgentProfileRegistry {
  resolveProfile(context: RequestContext, profileId: PiProfileId): Promise<PiAgentProfileSnapshot>;
  listProfiles(context: RequestContext): Promise<PiAgentProfileSnapshot[]>;
}

