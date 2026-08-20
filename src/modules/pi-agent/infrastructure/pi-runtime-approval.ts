import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiApproval, PiApprovalObjectVersionReader, PiApprovalObjectVersions } from "@/src/modules/pi-agent/domain/approval-contracts";
import type { PiRunStore, PiSessionStore } from "@/src/modules/pi-agent/domain/contracts";

const RUNTIME_VERSION_KEYS = new Set(["manifestDigest", "profileVersion", "policyVersion", "sandboxRunId"]);

function unavailable(): never {
  throw new Error("PI_APPROVAL_REVALIDATION_UNAVAILABLE");
}

function assertDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return unavailable();
  return value.toLowerCase();
}

/**
 * Re-reads the immutable run facts bound into a Pi tool approval. This keeps
 * generic workspace/MCP approvals separate from the change-delivery reader,
 * while still preventing a permit from being reused for another manifest or
 * sandbox run after the approval decision.
 */
export class PiRuntimeApprovalObjectVersionReader implements PiApprovalObjectVersionReader {
  constructor(
    private readonly sessions: PiSessionStore,
    private readonly runs: PiRunStore,
  ) {}

  async read(context: RequestContext, approval: PiApproval): Promise<PiApprovalObjectVersions> {
    if (!approval.runId || approval.tenantId !== context.tenantId) return unavailable();
    const expectedKeys = Object.keys(approval.expectedObjectVersions);
    if (expectedKeys.length === 0 || expectedKeys.some((key) => !RUNTIME_VERSION_KEYS.has(key))) return unavailable();
    const session = await this.sessions.getSession(context, approval.sessionId);
    const manifest = await this.runs.getManifest(context, approval.runId);
    if (!session || !manifest || session.tenantId !== approval.tenantId || session.id !== approval.sessionId || manifest.tenantId !== approval.tenantId || manifest.sessionId !== approval.sessionId || manifest.runId !== approval.runId) return unavailable();
    const values: PiApprovalObjectVersions = {
      manifestDigest: assertDigest(manifest.manifestDigest),
      profileVersion: session.profileVersion,
      policyVersion: session.policyVersion,
      sandboxRunId: session.sandboxRunId,
    };
    const actual: PiApprovalObjectVersions = {};
    for (const key of expectedKeys) {
      const value = values[key];
      const expected = approval.expectedObjectVersions[key];
      if (value === undefined || (typeof expected === "string" && typeof value !== "string") || (typeof expected === "number" && typeof value !== "number")) return unavailable();
      actual[key] = value;
    }
    return actual;
  }
}
