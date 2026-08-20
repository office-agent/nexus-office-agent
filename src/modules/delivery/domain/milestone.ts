export type MilestoneStatus = "planned" | "active" | "at_risk" | "completed" | "missed" | "cancelled";

export type Milestone = {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  ownerId: string;
  dueAt: string;
  status: MilestoneStatus;
  acceptanceCriteria: string;
  completedAt?: string;
  version: number;
};

const MILESTONE_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
  planned: ["active", "cancelled"],
  active: ["at_risk", "completed", "missed", "cancelled"],
  at_risk: ["active", "completed", "missed", "cancelled"],
  completed: [],
  missed: ["completed"],
  cancelled: [],
};

export function transitionMilestone(milestone: Milestone, next: MilestoneStatus, now = new Date()): Milestone {
  if (!MILESTONE_TRANSITIONS[milestone.status].includes(next)) {
    throw new Error(`MILESTONE_INVALID_TRANSITION:${milestone.status}:${next}`);
  }
  return {
    ...milestone,
    status: next,
    completedAt: next === "completed" ? now.toISOString() : milestone.completedAt,
    version: milestone.version + 1,
  };
}
