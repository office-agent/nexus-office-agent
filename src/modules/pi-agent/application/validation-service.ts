import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiSandbox } from "@/src/modules/pi-agent/domain/contracts";
import type { PiWorkspaceArtifact, PiWorkspaceRecord } from "@/src/modules/pi-agent/domain/workspace-contracts";
import {
  type PiValidationCheck,
  type PiValidationCheckResult,
  type PiValidationCommandExecutor,
  type PiValidationPlan,
  type PiValidationRunResult,
} from "@/src/modules/pi-agent/domain/validation-contracts";
import { sha256, stableJson } from "@/src/modules/pi-agent/application/manifest";
import type { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";

const MAX_CHECKS = 32;
const MAX_PLAN_ID_LENGTH = 128;
const MAX_CHECK_ID_LENGTH = 64;
const MAX_COMMAND_LENGTH = 8_000;
const MIN_CHECK_OUTPUT_BYTES = 1_024;
const MAX_CHECK_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_CHECK_OUTPUT_BYTES = 512 * 1024;
const MIN_CHECK_DURATION_MS = 1_000;
const MAX_CHECK_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_CHECK_DURATION_MS = 5 * 60 * 1000;

type NormalizedCheck = Required<Omit<PiValidationCheck, "classification">> & {
  classification: Exclude<PiValidationCheck["classification"], undefined>;
};

type NormalizedPlan = Omit<PiValidationPlan, "checks"> & { checks: NormalizedCheck[] };

type CheckExecution = {
  output: string;
  exitCode?: number;
  errorCode?: string;
  status: "passed" | "failed" | "unknown";
};

function validationCode(error: unknown): string {
  return error instanceof Error ? error.message.split(":")[0] || "PI_VALIDATION_EXECUTION_UNKNOWN" : "PI_VALIDATION_EXECUTION_UNKNOWN";
}

function assertSafeId(value: string, code: string, maxLength: number): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized) || normalized.length > maxLength) throw new Error(code);
  return normalized;
}

function assertCommand(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_COMMAND_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("PI_VALIDATION_COMMAND_INVALID");
  return normalized;
}

function normalizeCheck(check: PiValidationCheck): NormalizedCheck {
  if (!check || (check.kind !== "test" && check.kind !== "scan")) throw new Error("PI_VALIDATION_CHECK_INVALID");
  const maxOutputBytes = check.maxOutputBytes ?? DEFAULT_CHECK_OUTPUT_BYTES;
  const maxDurationMs = check.maxDurationMs ?? DEFAULT_CHECK_DURATION_MS;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < MIN_CHECK_OUTPUT_BYTES || maxOutputBytes > MAX_CHECK_OUTPUT_BYTES) throw new Error("PI_VALIDATION_OUTPUT_LIMIT_INVALID");
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < MIN_CHECK_DURATION_MS || maxDurationMs > MAX_CHECK_DURATION_MS) throw new Error("PI_VALIDATION_DURATION_LIMIT_INVALID");
  const classification = check.classification ?? "internal";
  if ((classification as string) === "public") throw new Error("PI_VALIDATION_CLASSIFICATION_INVALID");
  return {
    id: assertSafeId(check.id, "PI_VALIDATION_CHECK_ID_INVALID", MAX_CHECK_ID_LENGTH),
    kind: check.kind,
    command: assertCommand(check.command),
    classification,
    maxOutputBytes,
    maxDurationMs,
  };
}

function normalizePlan(plan: PiValidationPlan): NormalizedPlan {
  if (!plan || (plan.source !== "profile" && plan.source !== "tenant_policy")) throw new Error("PI_VALIDATION_PLAN_SOURCE_INVALID");
  if (!Number.isSafeInteger(plan.version) || plan.version < 1) throw new Error("PI_VALIDATION_PLAN_VERSION_INVALID");
  if (!Array.isArray(plan.checks) || plan.checks.length === 0 || plan.checks.length > MAX_CHECKS) throw new Error("PI_VALIDATION_CHECKS_INVALID");
  const checks = plan.checks.map(normalizeCheck);
  if (new Set(checks.map((check) => check.id)).size !== checks.length) throw new Error("PI_VALIDATION_CHECK_DUPLICATE");
  return {
    id: assertSafeId(plan.id, "PI_VALIDATION_PLAN_ID_INVALID", MAX_PLAN_ID_LENGTH),
    version: plan.version,
    source: plan.source,
    checks,
  };
}

export function computePiValidationPlanDigest(plan: PiValidationPlan): string {
  return sha256(stableJson(normalizePlan(plan)));
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function scopeMatches(context: RequestContext, workspace: PiWorkspaceRecord, sandbox: PiSandbox): void {
  if (
    context.sessionId !== workspace.sessionId ||
    sandbox.tenantId !== context.tenantId ||
    sandbox.actorId !== context.actorId ||
    sandbox.sessionId !== workspace.sessionId ||
    sandbox.workspaceId !== workspace.workspaceId ||
    sandbox.runId !== workspace.runId
  ) {
    throw new Error("PI_VALIDATION_SCOPE_MISMATCH");
  }
}

function statusForResult(result: { ok: boolean; exitCode?: number; errorCode?: string }): CheckExecution["status"] {
  if (result.errorCode) return "unknown";
  if (result.ok && (result.exitCode === undefined || result.exitCode === 0)) return "passed";
  if (!result.ok && (result.exitCode === undefined || result.exitCode !== 0)) return "failed";
  return "unknown";
}

async function executeWithTimeout(
  executor: PiValidationCommandExecutor,
  context: RequestContext,
  sandbox: PiSandbox,
  command: string,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<CheckExecution> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const result = await executor.exec(context, sandbox, command, controller.signal);
    if (parentSignal?.aborted) throw new Error("PI_RUN_ABORTED");
    if (timedOut) return { output: result.output ?? "", errorCode: "PI_VALIDATION_CHECK_TIMEOUT", status: "unknown" };
    return { output: result.output ?? "", exitCode: result.exitCode, errorCode: result.errorCode, status: statusForResult(result) };
  } catch (error) {
    if (parentSignal?.aborted) throw new Error("PI_RUN_ABORTED");
    return { output: "", errorCode: timedOut ? "PI_VALIDATION_CHECK_TIMEOUT" : validationCode(error), status: "unknown" };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function reportBytes(input: {
  plan: NormalizedPlan;
  planDigest: string;
  workspace: PiWorkspaceRecord;
  check: NormalizedCheck;
  result: CheckExecution;
  startedAt: string;
  completedAt: string;
}): Uint8Array {
  const output = truncateUtf8(input.result.output, input.check.maxOutputBytes);
  const report = {
    schemaVersion: 1,
    plan: { id: input.plan.id, version: input.plan.version, source: input.plan.source, digest: input.planDigest },
    workspace: { recordId: input.workspace.id, sessionId: input.workspace.sessionId, runId: input.workspace.runId },
    check: {
      id: input.check.id,
      kind: input.check.kind,
      commandDigest: sha256(input.check.command),
      status: input.result.status,
      exitCode: input.result.exitCode,
      errorCode: input.result.errorCode,
    },
    output: output.value,
    outputDigest: sha256(input.result.output),
    outputTruncated: output.truncated,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
  return Buffer.from(JSON.stringify(report), "utf8");
}

export class PiValidationFailedError extends Error {
  constructor(readonly result: PiValidationRunResult) {
    super("PI_VALIDATION_CHECK_FAILED");
    this.name = "PiValidationFailedError";
  }
}

export class PiValidationUnknownError extends Error {
  constructor(readonly result: PiValidationRunResult) {
    super("PI_VALIDATION_UNKNOWN");
    this.name = "PiValidationUnknownError";
  }
}

export class PiWorkspaceValidationService {
  constructor(
    private readonly workspaceService: Pick<PiWorkspaceService, "getWorkspace" | "registerArtifact">,
    private readonly executor: PiValidationCommandExecutor,
  ) {}

  async run(
    context: RequestContext,
    input: { workspaceRecordId: string; sandbox: PiSandbox; plan: PiValidationPlan; signal?: AbortSignal },
  ): Promise<PiValidationRunResult> {
    const plan = normalizePlan(input.plan);
    const planDigest = sha256(stableJson(plan));
    const workspace = await this.workspaceService.getWorkspace(context, input.workspaceRecordId);
    if (!["ready", "checkpointing"].includes(workspace.status)) throw new Error("PI_VALIDATION_WORKSPACE_NOT_ACTIVE");
    scopeMatches(context, workspace, input.sandbox);

    const startedAt = new Date().toISOString();
    const checks: PiValidationCheckResult[] = [];
    const artifactIds: string[] = [];
    for (const check of plan.checks) {
      if (input.signal?.aborted) throw new Error("PI_RUN_ABORTED");
      const checkStartedAt = new Date().toISOString();
      const result = await executeWithTimeout(this.executor, context, input.sandbox, check.command, input.signal, check.maxDurationMs);
      const checkCompletedAt = new Date().toISOString();
      const bytes = reportBytes({ plan, planDigest, workspace, check, result, startedAt: checkStartedAt, completedAt: checkCompletedAt });
      const artifact: PiWorkspaceArtifact = await this.workspaceService.registerArtifact(context, {
        sessionId: workspace.sessionId,
        runId: workspace.runId,
        workspaceRecordId: workspace.id,
        type: check.kind === "test" ? "test_report" : "scan_report",
        fileName: `validation-${plan.id}-${check.id}.json`,
        mediaType: "application/json",
        classification: check.classification,
        bytes,
      });
      artifactIds.push(artifact.id);
      checks.push({
        id: check.id,
        kind: check.kind,
        status: result.status,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        commandDigest: sha256(check.command),
        outputDigest: sha256(result.output),
        outputTruncated: Buffer.byteLength(result.output, "utf8") > check.maxOutputBytes,
        artifactId: artifact.id,
      });
      if (result.status === "unknown") break;
    }

    const failedCheckIds = checks.filter((check) => check.status === "failed").map((check) => check.id);
    const unknownCheckIds = checks.filter((check) => check.status === "unknown").map((check) => check.id);
    return {
      planId: plan.id,
      planVersion: plan.version,
      planDigest,
      status: unknownCheckIds.length > 0 ? "unknown" : failedCheckIds.length > 0 ? "failed" : "passed",
      checks,
      failedCheckIds,
      unknownCheckIds,
      artifactIds,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}
