import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiSandbox, PiSandboxResult } from "@/src/modules/pi-agent/domain/contracts";
import type { PiArtifactClassification, PiWorkspaceArtifact } from "@/src/modules/pi-agent/domain/workspace-contracts";

export type PiValidationCheckKind = "test" | "scan";
export type PiValidationPlanSource = "profile" | "tenant_policy";
export type PiValidationCheckStatus = "passed" | "failed" | "unknown";

/**
 * A validation plan is resolved by the server from an approved profile or
 * tenant policy. Model text, repository files and HTTP request fields must
 * never be used as a plan source.
 */
export type PiValidationCheck = {
  id: string;
  kind: PiValidationCheckKind;
  command: string;
  classification?: Exclude<PiArtifactClassification, "public">;
  maxOutputBytes?: number;
  maxDurationMs?: number;
};

export type PiValidationPlan = {
  id: string;
  version: number;
  source: PiValidationPlanSource;
  checks: PiValidationCheck[];
};

export type PiValidationCheckResult = {
  id: string;
  kind: PiValidationCheckKind;
  status: PiValidationCheckStatus;
  exitCode?: number;
  errorCode?: string;
  commandDigest: string;
  outputDigest: string;
  outputTruncated: boolean;
  artifactId?: string;
};

export type PiValidationRunResult = {
  planId: string;
  planVersion: number;
  planDigest: string;
  status: PiValidationCheckStatus;
  checks: PiValidationCheckResult[];
  failedCheckIds: string[];
  unknownCheckIds: string[];
  artifactIds: string[];
  startedAt: string;
  completedAt: string;
};

export interface PiValidationCommandExecutor {
  exec(context: RequestContext, sandbox: PiSandbox, command: string, signal?: AbortSignal): Promise<PiSandboxResult>;
}

export type PiValidationArtifact = PiWorkspaceArtifact;
