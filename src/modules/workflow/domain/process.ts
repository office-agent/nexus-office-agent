export type ProcessDefinitionStatus = "draft" | "published" | "retired";
export type ProcessInstanceStatus = "running" | "approved" | "rejected" | "withdrawn" | "cancelled" | "failed";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "delegated" | "cancelled" | "escalated";

export type ApprovalNode = {
  key: string;
  type: "approval";
  name: string;
  approverIds: string[];
  mode: "any" | "all";
  next: string;
  slaHours: number;
  escalationApproverIds?: string[];
};

export type ConditionNode = {
  key: string;
  type: "condition";
  name: string;
  field: string;
  operator: "eq" | "neq" | "gte" | "lte" | "contains";
  value: string | number | boolean;
  whenTrue: string;
  whenFalse: string;
};

export type EndNode = {
  key: string;
  type: "end";
  name: string;
  outcome: "approved" | "rejected";
};

export type ProcessNode = ApprovalNode | ConditionNode | EndNode;

export type ProcessDefinition = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string;
  ownerId: string;
  status: ProcessDefinitionStatus;
  currentVersion: number;
  version: number;
};

export type ProcessDefinitionVersion = {
  id: string;
  tenantId: string;
  definitionId: string;
  version: number;
  startNodeKey: string;
  nodes: ProcessNode[];
  publishedBy: string;
  publishedAt: string;
};

export type ProcessInstance = {
  id: string;
  tenantId: string;
  definitionId: string;
  definitionVersion: number;
  requesterId: string;
  title: string;
  formSnapshot: Record<string, unknown>;
  status: ProcessInstanceStatus;
  currentNodeKey: string;
  riskLevel: 0 | 1 | 2 | 3 | 4;
  slaDueAt?: string;
  completedAt?: string;
  version: number;
  createdAt: string;
};

export type Approval = {
  id: string;
  tenantId: string;
  instanceId: string;
  nodeKey: string;
  approverId: string;
  requestedBy: string;
  status: ApprovalStatus;
  decision?: "approve" | "reject";
  comment?: string;
  delegatedFromId?: string;
  delegatedToId?: string;
  escalatedFromId?: string;
  escalationLevel?: number;
  dueAt: string;
  decidedAt?: string;
  version: number;
};

function referencedNodeKeys(node: ProcessNode): string[] {
  if (node.type === "approval") return [node.next];
  if (node.type === "condition") return [node.whenTrue, node.whenFalse];
  return [];
}

export function validateProcessGraph(startNodeKey: string, nodes: ProcessNode[]): void {
  if (!startNodeKey || nodes.length < 2) throw new Error("PROCESS_GRAPH_INCOMPLETE");
  const byKey = new Map<string, ProcessNode>();
  for (const node of nodes) {
    if (!node.key || byKey.has(node.key)) throw new Error("PROCESS_NODE_KEY_INVALID");
    if (node.type === "approval") {
      if (node.approverIds.length === 0 || new Set(node.approverIds).size !== node.approverIds.length) {
        throw new Error("PROCESS_APPROVERS_INVALID");
      }
      if (!Number.isInteger(node.slaHours) || node.slaHours <= 0) throw new Error("PROCESS_SLA_INVALID");
      if (node.escalationApproverIds && (
        node.escalationApproverIds.length === 0 ||
        new Set(node.escalationApproverIds).size !== node.escalationApproverIds.length
      )) throw new Error("PROCESS_ESCALATION_APPROVERS_INVALID");
    }
    byKey.set(node.key, node);
  }
  if (!byKey.has(startNodeKey)) throw new Error("PROCESS_START_NODE_MISSING");
  for (const node of nodes) {
    for (const reference of referencedNodeKeys(node)) {
      if (!byKey.has(reference)) throw new Error("PROCESS_NODE_REFERENCE_MISSING");
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error("PROCESS_GRAPH_CYCLE");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const next of referencedNodeKeys(byKey.get(key)!)) visit(next);
    visiting.delete(key);
    visited.add(key);
  };
  visit(startNodeKey);
  if (![...visited].some((key) => byKey.get(key)?.type === "end")) throw new Error("PROCESS_END_NODE_MISSING");
}

function readField(form: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, form);
}

function conditionMatches(node: ConditionNode, form: Record<string, unknown>): boolean {
  const actual = readField(form, node.field);
  switch (node.operator) {
    case "eq": return actual === node.value;
    case "neq": return actual !== node.value;
    case "gte": return typeof actual === "number" && typeof node.value === "number" && actual >= node.value;
    case "lte": return typeof actual === "number" && typeof node.value === "number" && actual <= node.value;
    case "contains": return Array.isArray(actual) ? actual.includes(node.value) : typeof actual === "string" && actual.includes(String(node.value));
  }
}

export function resolveRuntimeNode(
  definition: ProcessDefinitionVersion,
  startKey: string,
  form: Record<string, unknown>,
): ApprovalNode | EndNode {
  const byKey = new Map(definition.nodes.map((node) => [node.key, node]));
  let current = byKey.get(startKey);
  for (let hops = 0; hops <= definition.nodes.length; hops += 1) {
    if (!current) throw new Error("PROCESS_RUNTIME_NODE_MISSING");
    if (current.type !== "condition") return current;
    current = byKey.get(conditionMatches(current, form) ? current.whenTrue : current.whenFalse);
  }
  throw new Error("PROCESS_RUNTIME_CYCLE");
}

export function nextNodeAfterApproval(definition: ProcessDefinitionVersion, nodeKey: string): string {
  const node = definition.nodes.find((candidate) => candidate.key === nodeKey);
  if (!node || node.type !== "approval") throw new Error("PROCESS_APPROVAL_NODE_MISSING");
  return node.next;
}

export function decideApproval(
  approval: Approval,
  decision: "approve" | "reject",
  comment: string,
  now = new Date(),
): Approval {
  if (approval.status !== "pending") throw new Error("APPROVAL_INVALID_TRANSITION");
  if (!comment.trim() && decision === "reject") throw new Error("APPROVAL_REJECTION_COMMENT_REQUIRED");
  return {
    ...approval,
    status: decision === "approve" ? "approved" : "rejected",
    decision,
    comment: comment.trim(),
    decidedAt: now.toISOString(),
    version: approval.version + 1,
  };
}

export function delegateApproval(approval: Approval, delegateId: string): Approval {
  if (approval.status !== "pending") throw new Error("APPROVAL_INVALID_TRANSITION");
  if (!delegateId || delegateId === approval.approverId) throw new Error("APPROVAL_DELEGATE_INVALID");
  if (approval.delegatedFromId) throw new Error("APPROVAL_REDELEGATION_DISABLED");
  return { ...approval, status: "delegated", delegatedToId: delegateId, version: approval.version + 1 };
}
