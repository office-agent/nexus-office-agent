import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiApproval, PiApprovalObjectVersionReader, PiApprovalObjectVersions } from "@/src/modules/pi-agent/domain/approval-contracts";
import type { PiChangeDeliveryEvidenceReader, PiChangeDeliveryStore } from "@/src/modules/pi-agent/domain/change-delivery-contracts";

const CHANGE_VERSION_KEYS = new Set([
  "workspaceRecordId",
  "baseCommitSha",
  "headCommitSha",
  "branch",
  "targetBranch",
  "pullRequestVersion",
  "submissionVersion",
]);

function unavailable(): never {
  throw new Error("PI_APPROVAL_REVALIDATION_UNAVAILABLE");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Re-reads the immutable change-delivery facts used by an approval permit.
 * Non-change approvals intentionally remain fail-closed because this reader
 * only understands the version keys issued by PiChangeDeliveryService.
 */
export class PiChangeDeliveryApprovalObjectVersionReader implements PiApprovalObjectVersionReader {
  constructor(
    private readonly store: PiChangeDeliveryStore,
    private readonly evidence: PiChangeDeliveryEvidenceReader,
  ) {}

  async read(context: RequestContext, approval: PiApproval): Promise<PiApprovalObjectVersions> {
    const expected = approval.expectedObjectVersions;
    const keys = Object.keys(expected);
    if (keys.length === 0 || keys.some((key) => !CHANGE_VERSION_KEYS.has(key)) || !text(expected.workspaceRecordId)) return unavailable();

    const workspace = await this.evidence.getWorkspace(context, String(expected.workspaceRecordId));
    if (workspace.tenantId !== approval.tenantId || workspace.sessionId !== approval.sessionId || (approval.runId && workspace.runId !== approval.runId)) return unavailable();

    const submissions = await this.store.listSubmissions(context);
    const submission = submissions
      .filter((item) => item.workspaceRecordId === workspace.id && item.sessionId === approval.sessionId && (!approval.runId || item.runId === approval.runId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!submission) return unavailable();

    const pullRequests = await this.store.listPullRequests(context);
    const pullRequest = pullRequests.find((item) => item.submissionId === submission.id);
    const mergeProposal = (await this.store.listMergeProposals(context)).find((item) => item.approvalId === approval.id);
    const releaseProposal = (await this.store.listReleaseProposals(context)).find((item) => item.approvalId === approval.id);

    const values: Record<string, string | number | undefined> = {
      workspaceRecordId: workspace.id,
      baseCommitSha: submission.baseCommitSha,
      headCommitSha: submission.headCommitSha,
      branch: submission.branch,
      targetBranch: mergeProposal?.targetBranch ?? submission.targetBranch,
      pullRequestVersion: pullRequest?.version,
      submissionVersion: submission.version,
    };
    // A release proposal still binds its approval to the exact PR version, but
    // must not silently accept a missing PR when that key was recorded.
    if (releaseProposal?.pullRequestId && !pullRequest) return unavailable();

    const actual: PiApprovalObjectVersions = {};
    for (const key of keys) {
      const value = values[key];
      if (value === undefined || (typeof expected[key] === "string" && typeof value !== "string") || (typeof expected[key] === "number" && typeof value !== "number")) return unavailable();
      actual[key] = value;
    }
    return actual;
  }
}
