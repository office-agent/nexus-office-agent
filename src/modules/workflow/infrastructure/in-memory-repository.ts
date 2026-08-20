import type { WorkflowRepository, WorkflowSnapshot } from "@/src/modules/workflow/application/contracts";
import type { Approval, ProcessDefinition, ProcessDefinitionVersion, ProcessInstance } from "@/src/modules/workflow/domain/process";
import { DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

export const DEMO_PROCESS_DEFINITION_ID = "81000000-0000-4000-8000-000000000001";
export const DEMO_PROCESS_INSTANCE_ID = "82000000-0000-4000-8000-000000000001";
export const DEMO_APPROVAL_ID = "83000000-0000-4000-8000-000000000001";
export const DEMO_REQUESTER_ID = "10000000-0000-4000-8000-000000000002";

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly definitions = new Map<string, ProcessDefinition>();
  private readonly definitionVersions = new Map<string, ProcessDefinitionVersion>();
  private readonly instances = new Map<string, ProcessInstance>();
  private readonly approvals = new Map<string, Approval>();

  constructor(seed = true) {
    if (seed) this.seed();
  }

  async getDefinition(tenantId: string, id: string): Promise<ProcessDefinition | null> {
    const definition = this.definitions.get(id);
    return definition?.tenantId === tenantId ? structuredClone(definition) : null;
  }

  async getDefinitionVersion(tenantId: string, definitionId: string, version: number): Promise<ProcessDefinitionVersion | null> {
    const item = this.definitionVersions.get(`${definitionId}:${version}`);
    return item?.tenantId === tenantId ? structuredClone(item) : null;
  }

  async savePublishedDefinition(definition: ProcessDefinition, version: ProcessDefinitionVersion): Promise<void> {
    this.definitions.set(definition.id, structuredClone(definition));
    this.definitionVersions.set(`${version.definitionId}:${version.version}`, structuredClone(version));
  }

  async getInstance(tenantId: string, id: string): Promise<ProcessInstance | null> {
    const instance = this.instances.get(id);
    return instance?.tenantId === tenantId ? structuredClone(instance) : null;
  }

  async saveInstance(instance: ProcessInstance, expectedVersion?: number): Promise<boolean> {
    const current = this.instances.get(instance.id);
    if (expectedVersion !== undefined && current?.version !== expectedVersion) return false;
    if (current && current.tenantId !== instance.tenantId) return false;
    this.instances.set(instance.id, structuredClone(instance));
    return true;
  }

  async listApprovals(tenantId: string, instanceId: string, nodeKey?: string): Promise<Approval[]> {
    return [...this.approvals.values()]
      .filter((item) => item.tenantId === tenantId && item.instanceId === instanceId && (!nodeKey || item.nodeKey === nodeKey))
      .map((item) => structuredClone(item));
  }

  async listOverdueApprovals(tenantId: string, dueBefore: string, limit: number): Promise<Approval[]> {
    return [...this.approvals.values()]
      .filter((item) => item.tenantId === tenantId && item.status === "pending" && !item.escalatedFromId && item.dueAt <= dueBefore)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  async getApproval(tenantId: string, id: string): Promise<Approval | null> {
    const approval = this.approvals.get(id);
    return approval?.tenantId === tenantId ? structuredClone(approval) : null;
  }

  async saveApprovals(approvals: Approval[]): Promise<void> {
    for (const approval of approvals) this.approvals.set(approval.id, structuredClone(approval));
  }

  async saveApproval(approval: Approval, expectedVersion: number): Promise<boolean> {
    const current = this.approvals.get(approval.id);
    if (!current || current.tenantId !== approval.tenantId || current.version !== expectedVersion) return false;
    this.approvals.set(approval.id, structuredClone(approval));
    return true;
  }

  async getSnapshot(tenantId: string, actorId: string): Promise<WorkflowSnapshot> {
    return {
      definitions: [...this.definitions.values()].filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item)),
      instances: [...this.instances.values()].filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item)),
      pendingApprovals: [...this.approvals.values()]
        .filter((item) => item.tenantId === tenantId && item.approverId === actorId && item.status === "pending")
        .map((item) => structuredClone(item)),
      generatedAt: new Date().toISOString(),
    };
  }

  private seed() {
    const definition: ProcessDefinition = {
      id: DEMO_PROCESS_DEFINITION_ID, tenantId: DEMO_TENANT_ID, code: "BUDGET-CHANGE",
      name: "预算追加审批", description: "高风险预算变更必须由申请人之外的负责人批准。",
      ownerId: DEMO_MANAGER_ID, status: "published", currentVersion: 1, version: 1,
    };
    const version: ProcessDefinitionVersion = {
      id: "81100000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID,
      definitionId: definition.id, version: 1, startNodeKey: "manager_review",
      nodes: [
        { key: "manager_review", type: "approval", name: "负责人审批", approverIds: [DEMO_MANAGER_ID], mode: "all", next: "approved", slaHours: 24 },
        { key: "approved", type: "end", name: "审批完成", outcome: "approved" },
      ],
      publishedBy: DEMO_MANAGER_ID, publishedAt: "2026-08-01T02:00:00.000Z",
    };
    const instance: ProcessInstance = {
      id: DEMO_PROCESS_INSTANCE_ID, tenantId: DEMO_TENANT_ID, definitionId: definition.id,
      definitionVersion: 1, requesterId: DEMO_REQUESTER_ID, title: "8 月云资源预算追加",
      formSnapshot: { amount: 186400, currency: "CNY", reason: "峰值扩容", evidence: "压测报告待补充" },
      status: "running", currentNodeKey: "manager_review", riskLevel: 3,
      slaDueAt: "2026-08-06T04:00:00.000Z", version: 1, createdAt: "2026-08-05T02:00:00.000Z",
    };
    const approval: Approval = {
      id: DEMO_APPROVAL_ID, tenantId: DEMO_TENANT_ID, instanceId: instance.id, nodeKey: "manager_review",
      approverId: DEMO_MANAGER_ID, requestedBy: DEMO_REQUESTER_ID, status: "pending",
      dueAt: "2026-08-06T04:00:00.000Z", version: 1,
    };
    this.definitions.set(definition.id, definition);
    this.definitionVersions.set(`${definition.id}:1`, version);
    this.instances.set(instance.id, instance);
    this.approvals.set(approval.id, approval);
  }
}

const runtime = globalThis as typeof globalThis & { __nexusWorkflowRepository?: InMemoryWorkflowRepository; __nexusWorkflowRepositoryVersion?: number };

export function getDevelopmentWorkflowRepository() {
  if (runtime.__nexusWorkflowRepositoryVersion !== 1) {
    runtime.__nexusWorkflowRepository = new InMemoryWorkflowRepository();
    runtime.__nexusWorkflowRepositoryVersion = 1;
  }
  return runtime.__nexusWorkflowRepository!;
}
