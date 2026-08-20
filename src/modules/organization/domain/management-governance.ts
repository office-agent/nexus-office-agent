export type RaciRole = "accountable" | "responsible" | "consulted" | "informed";

export type ResponsibilityAssignment = {
  id: string;
  tenantId: string;
  resourceType: "objective" | "project" | "metric" | "process";
  resourceId: string;
  subjectType: "user" | "position" | "governance_group";
  subjectId: string;
  role: RaciRole;
  startsAt: string;
  endsAt?: string;
  version: number;
};

export type CapacityAllocation = {
  resourceType: "project" | "operations" | "learning" | "leave";
  resourceId: string;
  allocationPercent: number;
};

export type CapacityPlan = {
  id: string;
  tenantId: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  availableHours: number;
  allocations: CapacityAllocation[];
  includedSignals: string[];
  version: number;
};

const PROHIBITED_MONITORING_SIGNALS = new Set(["online_time", "message_count", "keyboard_activity", "screen_time", "camera_presence"]);

export function assertRaci(assignments: ResponsibilityAssignment[]): void {
  const accountable = assignments.filter(({ role }) => role === "accountable");
  if (accountable.length !== 1) throw new Error("RACI_SINGLE_ACCOUNTABLE_REQUIRED");
  if (!assignments.some(({ role }) => role === "responsible")) throw new Error("RACI_RESPONSIBLE_REQUIRED");
  const keys = assignments.map(({ subjectType, subjectId, role }) => `${subjectType}:${subjectId}:${role}`);
  if (new Set(keys).size !== keys.length) throw new Error("RACI_DUPLICATE_ASSIGNMENT");
}

export function capacityStatus(plan: CapacityPlan): { utilizationPercent: number; allocatedHours: number; status: "available" | "balanced" | "near_limit" | "overloaded" } {
  if (plan.availableHours <= 0 || plan.periodEnd < plan.periodStart) throw new Error("CAPACITY_PLAN_INVALID");
  if (plan.allocations.some(({ allocationPercent }) => allocationPercent < 0 || allocationPercent > 100)) throw new Error("CAPACITY_ALLOCATION_INVALID");
  if (plan.includedSignals.some((signal) => PROHIBITED_MONITORING_SIGNALS.has(signal))) throw new Error("MONITORING_SIGNAL_PROHIBITED");
  const utilizationPercent = plan.allocations.reduce((sum, item) => sum + item.allocationPercent, 0);
  const status = utilizationPercent > 100 ? "overloaded" : utilizationPercent >= 90 ? "near_limit" : utilizationPercent >= 60 ? "balanced" : "available";
  return { utilizationPercent, allocatedHours: plan.availableHours * utilizationPercent / 100, status };
}
