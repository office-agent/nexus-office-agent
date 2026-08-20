export type IssueStatus = "open" | "investigating" | "resolving" | "resolved" | "closed";

export type Issue = {
  id: string;
  tenantId: string;
  projectId: string;
  riskId?: string;
  title: string;
  description: string;
  ownerId: string;
  severity: "critical" | "high" | "medium" | "low";
  status: IssueStatus;
  resolution?: string;
  version: number;
};

const ISSUE_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  open: ["investigating", "closed"],
  investigating: ["resolving", "closed"],
  resolving: ["resolved", "investigating"],
  resolved: ["closed", "resolving"],
  closed: [],
};

export function transitionIssue(issue: Issue, next: IssueStatus, resolution?: string): Issue {
  if (!ISSUE_TRANSITIONS[issue.status].includes(next)) throw new Error(`ISSUE_INVALID_TRANSITION:${issue.status}:${next}`);
  if (["resolved", "closed"].includes(next) && !resolution?.trim() && !issue.resolution?.trim()) {
    throw new Error("ISSUE_RESOLUTION_REQUIRED");
  }
  return { ...issue, status: next, resolution: resolution?.trim() || issue.resolution, version: issue.version + 1 };
}
