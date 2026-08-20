import type { Approval, ProcessDefinition, ProcessDefinitionVersion, ProcessInstance } from "@/src/modules/workflow/domain/process";

export type WorkflowSnapshot = {
  definitions: ProcessDefinition[];
  instances: ProcessInstance[];
  pendingApprovals: Approval[];
  generatedAt: string;
};

export interface WorkflowRepository {
  getDefinition(tenantId: string, id: string): Promise<ProcessDefinition | null>;
  getDefinitionVersion(tenantId: string, definitionId: string, version: number): Promise<ProcessDefinitionVersion | null>;
  savePublishedDefinition(definition: ProcessDefinition, version: ProcessDefinitionVersion): Promise<void>;
  getInstance(tenantId: string, id: string): Promise<ProcessInstance | null>;
  saveInstance(instance: ProcessInstance, expectedVersion?: number): Promise<boolean>;
  listApprovals(tenantId: string, instanceId: string, nodeKey?: string): Promise<Approval[]>;
  listOverdueApprovals(tenantId: string, dueBefore: string, limit: number): Promise<Approval[]>;
  getApproval(tenantId: string, id: string): Promise<Approval | null>;
  saveApprovals(approvals: Approval[]): Promise<void>;
  saveApproval(approval: Approval, expectedVersion: number): Promise<boolean>;
  getSnapshot(tenantId: string, actorId: string): Promise<WorkflowSnapshot>;
}
