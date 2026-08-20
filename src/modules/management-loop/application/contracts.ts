import type { Objective } from "@/src/modules/strategy/domain/objective";
import type { Project } from "@/src/modules/delivery/domain/project";
import type { Risk } from "@/src/modules/governance/domain/risk";
import type { Decision } from "@/src/modules/governance/domain/decision";
import type { ActionItem } from "@/src/modules/collaboration/domain/action-item";
import type { Milestone } from "@/src/modules/delivery/domain/milestone";
import type { DeliveryTask } from "@/src/modules/delivery/domain/task";
import type { Issue } from "@/src/modules/governance/domain/issue";

export type ManagementSnapshot = {
  objective: Objective;
  project: Project;
  risks: Risk[];
  decisions: Decision[];
  actionItems: ActionItem[];
  milestones: Milestone[];
  tasks: DeliveryTask[];
  issues: Issue[];
  generatedAt: string;
};

export interface ManagementLoopRepository {
  getSnapshot(tenantId: string, projectId: string): Promise<ManagementSnapshot | null>;
  saveRisk(risk: Risk): Promise<void>;
  saveDecision(decision: Decision): Promise<void>;
  getDecision(tenantId: string, id: string): Promise<Decision | null>;
  replaceDecision(original: Decision, replacement: Decision, expectedOriginalVersion: number): Promise<boolean>;
  saveActionItems(items: ActionItem[]): Promise<void>;
  getActionItem(tenantId: string, id: string): Promise<ActionItem | null>;
  saveActionItem(item: ActionItem): Promise<void>;
  getTask(tenantId: string, id: string): Promise<DeliveryTask | null>;
  saveTask(task: DeliveryTask): Promise<void>;
  saveIssue(issue: Issue): Promise<void>;
}
