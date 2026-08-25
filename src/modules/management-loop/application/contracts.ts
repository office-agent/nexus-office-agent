import type { Objective } from "@/src/modules/strategy/domain/objective";
import type { Project } from "@/src/modules/delivery/domain/project";
import type { Risk } from "@/src/modules/governance/domain/risk";
import type { Decision } from "@/src/modules/governance/domain/decision";
import type { ActionItem } from "@/src/modules/collaboration/domain/action-item";
import type { Milestone } from "@/src/modules/delivery/domain/milestone";
import type { DeliveryTask } from "@/src/modules/delivery/domain/task";
import type { Issue } from "@/src/modules/governance/domain/issue";
import type { DomainEvent } from "@/src/modules/events/domain/event-envelope";

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
  getRisk(tenantId: string, id: string): Promise<Risk | null>;
  saveRisk(risk: Risk, event: DomainEvent): Promise<void>;
  saveDecision(decision: Decision, actionItems: ActionItem[], event: DomainEvent): Promise<void>;
  getDecision(tenantId: string, id: string): Promise<Decision | null>;
  replaceDecision(original: Decision, replacement: Decision, expectedOriginalVersion: number, event: DomainEvent): Promise<boolean>;
  getActionItem(tenantId: string, id: string): Promise<ActionItem | null>;
  saveActionItem(item: ActionItem, expectedVersion: number, event: DomainEvent): Promise<boolean>;
  getTask(tenantId: string, id: string): Promise<DeliveryTask | null>;
  saveTask(task: DeliveryTask, expectedVersion: number, event: DomainEvent): Promise<boolean>;
  saveIssue(issue: Issue, event: DomainEvent): Promise<void>;
}
