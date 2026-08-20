export type DeliveryTaskStatus = "todo" | "in_progress" | "blocked" | "in_review" | "completed" | "cancelled";

export type DeliveryTask = {
  id: string;
  tenantId: string;
  projectId: string;
  milestoneId?: string;
  parentId?: string;
  title: string;
  description: string;
  assigneeId: string;
  status: DeliveryTaskStatus;
  priority: "critical" | "high" | "medium" | "low";
  dueAt?: string;
  completedAt?: string;
  version: number;
};

const TASK_TRANSITIONS: Record<DeliveryTaskStatus, DeliveryTaskStatus[]> = {
  todo: ["in_progress", "cancelled"],
  in_progress: ["blocked", "in_review", "completed", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  in_review: ["in_progress", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function transitionTask(task: DeliveryTask, next: DeliveryTaskStatus, now = new Date()): DeliveryTask {
  if (!TASK_TRANSITIONS[task.status].includes(next)) throw new Error(`TASK_INVALID_TRANSITION:${task.status}:${next}`);
  return {
    ...task,
    status: next,
    completedAt: next === "completed" ? now.toISOString() : task.completedAt,
    version: task.version + 1,
  };
}
