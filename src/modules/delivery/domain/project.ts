export type ProjectStatus = "draft" | "proposed" | "approved" | "active" | "paused" | "closing" | "completed" | "cancelled";
export type ProjectHealth = "unknown" | "healthy" | "watch" | "at_risk" | "critical";

export type Project = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string;
  ownerId: string;
  sponsorId?: string;
  status: ProjectStatus;
  priority: "critical" | "high" | "medium" | "low";
  startsAt: string;
  targetEndAt: string;
  health: ProjectHealth;
  version: number;
};

const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ["proposed", "cancelled"],
  proposed: ["approved", "draft", "cancelled"],
  approved: ["active", "cancelled"],
  active: ["paused", "closing", "cancelled"],
  paused: ["active", "cancelled"],
  closing: ["active", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function transitionProject(project: Project, next: ProjectStatus): Project {
  if (!PROJECT_TRANSITIONS[project.status].includes(next)) throw new Error(`PROJECT_INVALID_TRANSITION:${project.status}:${next}`);
  return { ...project, status: next, version: project.version + 1 };
}

export function deriveProjectHealth(exposures: number[], overdueCriticalActions: number): ProjectHealth {
  const highest = Math.max(0, ...exposures);
  if (highest >= 20 || overdueCriticalActions >= 2) return "critical";
  if (highest >= 12 || overdueCriticalActions === 1) return "at_risk";
  if (highest >= 6) return "watch";
  return exposures.length > 0 ? "healthy" : "unknown";
}

