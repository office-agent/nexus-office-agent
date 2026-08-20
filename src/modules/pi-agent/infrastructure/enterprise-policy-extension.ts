import type {
  ExtensionFactory,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { RequestContext } from "@/src/platform/context/request-context";
import type {
  PiApproval,
  PiApprovalExecutionPermit,
  PiApprovalObjectVersionReader,
  PiApprovalObjectVersions,
} from "@/src/modules/pi-agent/domain/approval-contracts";
import type { PiProfileId, PiRiskLevel, PiSession } from "@/src/modules/pi-agent/domain/contracts";
import { PiApprovalService } from "@/src/modules/pi-agent/application/approval-service";
import { stableJson, sha256 } from "@/src/modules/pi-agent/application/manifest";
import { getPiProfile } from "@/src/modules/pi-agent/domain/profiles";
import { classifyUntrustedValue, redactedSensitivePlaceholder } from "@/src/platform/security/data-classification";

const RISK_RANK: Record<PiRiskLevel, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };
const DEFAULT_POLL_MS = 250;
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;

export type PiEnterprisePolicyExtensionOptions = {
  context: RequestContext;
  record: PiSession;
  runId: string;
  approvalService?: PiApprovalService;
  approvalObjectVersions?: PiApprovalObjectVersions;
  approvalObjectVersionReader?: PiApprovalObjectVersionReader;
  pollMs?: number;
  waitTimeoutMs?: number;
  now?: () => Date;
  onApprovalRequired?: (input: { approval: PiApproval; created: boolean }) => Promise<void> | void;
  onApprovalResumed?: (input: { approval: PiApproval; permit: PiApprovalExecutionPermit }) => Promise<void> | void;
  onApprovalDenied?: (input: { approval: PiApproval; reason: string }) => Promise<void> | void;
};

function riskForTool(record: PiSession, toolName: string): PiRiskLevel | undefined {
  const binding = record.mcpBindings.find((item) => item.exposedName === toolName);
  if (binding) return binding.riskLevel;
  if (toolName === "workspace_read" || toolName === "workspace_list") return "R0";
  if (toolName === "workspace_write" || toolName === "workspace_apply_patch") return "R1";
  if (toolName === "workspace_run") return record.profile === "release" ? "R3" : "R2";
  return undefined;
}

function allowedToolNames(record: PiSession): Set<string> {
  const profile = getPiProfile(record.profile);
  return new Set([...profile.allowedTools, ...record.mcpBindings.map((binding) => binding.exposedName)]);
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.split(":", 1)[0] || "PI_TOOL_POLICY_FAILED" : "PI_TOOL_POLICY_FAILED";
}

function previewFor(toolName: string, input: Record<string, unknown>): string {
  const serialized = stableJson(input);
  if (classifyUntrustedValue(input) === "restricted") return `${toolName}: ${redactedSensitivePlaceholder()}`;
  return `${toolName}: ${serialized.slice(0, 19_500)}`;
}

function assertPositiveInteger(value: number | undefined, fallback: number, code: string, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(code);
  return resolved;
}

function assertObjectVersions(value: PiApprovalObjectVersions | undefined): PiApprovalObjectVersions {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error("PI_APPROVAL_OBJECT_VERSIONS_UNAVAILABLE");
  }
  return structuredClone(value);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("PI_APPROVAL_WAIT_ABORTED"));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    const abortListener = () => {
      clearTimeout(timer);
      onAbort();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abortListener);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abortListener, { once: true });
  });
}

async function waitForApproval(input: {
  service: PiApprovalService;
  context: RequestContext;
  approval: PiApproval;
  objectVersionReader?: PiApprovalObjectVersionReader;
  pollMs: number;
  waitTimeoutMs: number;
  now: () => Date;
  signal?: AbortSignal;
}): Promise<{ approval: PiApproval; permit: PiApprovalExecutionPermit }> {
  const deadline = Date.now() + input.waitTimeoutMs;
  while (true) {
    if (input.signal?.aborted) throw new Error("PI_APPROVAL_WAIT_ABORTED");
    const current = await input.service.get(input.context, input.approval.id);
    if (current.status === "approved") {
      const permit = await input.service.resumeToolCall(input.context, current.id, input.now(), input.objectVersionReader);
      return { approval: await input.service.get(input.context, current.id), permit };
    }
    if (current.status !== "pending") throw new Error(`PI_APPROVAL_DENIED:${current.status}`);
    const now = input.now();
    if (new Date(current.expiresAt).getTime() <= now.getTime()) {
      await input.service.expire(input.context, current.id, now).catch(() => undefined);
      throw new Error("PI_APPROVAL_EXPIRED");
    }
    if (Date.now() >= deadline) throw new Error("PI_APPROVAL_WAIT_TIMEOUT");
    await delay(Math.min(input.pollMs, Math.max(1, deadline - Date.now())), input.signal);
  }
}

async function handleToolCall(options: PiEnterprisePolicyExtensionOptions, event: ToolCallEvent, signal?: AbortSignal): Promise<void> {
  const allowed = allowedToolNames(options.record);
  if (!allowed.has(event.toolName)) throw new Error("PI_TOOL_NOT_IN_MANIFEST");
  const riskLevel = riskForTool(options.record, event.toolName);
  if (!riskLevel) throw new Error("PI_TOOL_RISK_UNCLASSIFIED");
  const profile = getPiProfile(options.record.profile);
  if (RISK_RANK[riskLevel] > profile.maxRiskLevel) throw new Error("PI_TOOL_RISK_NOT_ALLOWED");
  if (riskLevel === "R4") throw new Error("PI_R4_DISABLED");
  if (RISK_RANK[riskLevel] < 2) return;
  if (!options.approvalService) throw new Error("PI_APPROVAL_RUNTIME_UNAVAILABLE");

  const expectedObjectVersions = assertObjectVersions(options.approvalObjectVersions);
  const inputDigest = sha256(stableJson(event.input));
  const idempotencyKey = `pi-tool:${options.record.id}:${options.runId}:${event.toolCallId}`;
  const proposal = await options.approvalService.createProposal(options.context, {
    sessionId: options.record.id,
    runId: options.runId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    toolVersion: 1,
    profile: options.record.profile as PiProfileId,
    riskLevel,
    preview: previewFor(event.toolName, event.input),
    inputDigest,
    expectedObjectVersions,
    idempotencyKey,
    now: options.now?.() ?? new Date(),
  });
  if (proposal.approval.status !== "pending") {
    if (proposal.approval.status !== "approved") throw new Error(`PI_APPROVAL_DENIED:${proposal.approval.status}`);
  } else {
    await options.onApprovalRequired?.({ approval: proposal.approval, created: proposal.created });
  }
  try {
    const resolved = proposal.approval.status === "approved"
      ? { approval: await options.approvalService.get(options.context, proposal.approval.id), permit: await options.approvalService.resumeToolCall(options.context, proposal.approval.id, options.now?.() ?? new Date(), options.approvalObjectVersionReader) }
      : await waitForApproval({
        service: options.approvalService,
        context: options.context,
        approval: proposal.approval,
        objectVersionReader: options.approvalObjectVersionReader,
        pollMs: assertPositiveInteger(options.pollMs, DEFAULT_POLL_MS, "PI_APPROVAL_POLL_INVALID", 10_000),
        waitTimeoutMs: assertPositiveInteger(options.waitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS, "PI_APPROVAL_WAIT_INVALID", 24 * 60 * 60_000),
        now: options.now ?? (() => new Date()),
        signal,
      });
    await options.onApprovalResumed?.(resolved);
  } catch (error) {
    try {
      await options.onApprovalDenied?.({ approval: proposal.approval, reason: errorCode(error) });
    } catch {
      // The original policy/approval failure remains the authoritative result.
    }
    throw error;
  }
}

/**
 * The only runtime extension installed by the server for every Pi run. It is
 * intentionally an inline factory so project `.pi/extensions` cannot replace
 * or bypass it. High-risk tools wait before execution; no tool is replayed
 * after approval and a denied/expired approval fails the run closed.
 */
export function createPiEnterprisePolicyExtension(options: PiEnterprisePolicyExtensionOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      await handleToolCall(options, event, ctx.signal);
    });
  };
}

export const __test__ = { handleToolCall, riskForTool, previewFor, waitForApproval };
