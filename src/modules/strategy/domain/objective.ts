export type ObjectiveStatus = "draft" | "proposed" | "active" | "at_risk" | "achieved" | "missed" | "cancelled" | "reviewed";

export type Objective = {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  ownerId: string;
  status: ObjectiveStatus;
  baseline?: number;
  targetValue?: number;
  currentValue?: number;
  unit?: string;
  startsAt: string;
  endsAt: string;
  reviewCadence: "daily" | "weekly" | "monthly" | "quarterly";
  version: number;
};

const TRANSITIONS: Record<ObjectiveStatus, ObjectiveStatus[]> = {
  draft: ["proposed", "cancelled"],
  proposed: ["active", "draft", "cancelled"],
  active: ["at_risk", "achieved", "missed", "cancelled"],
  at_risk: ["active", "achieved", "missed", "cancelled"],
  achieved: ["reviewed"],
  missed: ["reviewed"],
  cancelled: ["reviewed"],
  reviewed: [],
};

export function transitionObjective(objective: Objective, next: ObjectiveStatus): Objective {
  if (!TRANSITIONS[objective.status].includes(next)) throw new Error(`OBJECTIVE_INVALID_TRANSITION:${objective.status}:${next}`);
  return { ...objective, status: next, version: objective.version + 1 };
}

export function objectiveProgress(objective: Objective): number | null {
  const { baseline, targetValue, currentValue } = objective;
  if (baseline === undefined || targetValue === undefined || currentValue === undefined || targetValue === baseline) return null;
  return Math.max(0, Math.min(1, (currentValue - baseline) / (targetValue - baseline)));
}

