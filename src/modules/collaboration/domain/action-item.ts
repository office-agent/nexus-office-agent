export type ActionItemStatus = "open" | "in_progress" | "blocked" | "completed" | "cancelled";

export type ActionItem = {
  id: string;
  tenantId: string;
  decisionId?: string;
  projectId?: string;
  title: string;
  description: string;
  ownerId: string;
  dueAt: string;
  acceptanceCriteria: string;
  status: ActionItemStatus;
  completedAt?: string;
  completionEvidence?: string;
  version: number;
};

export function startActionItem(item: ActionItem): ActionItem {
  if (item.status !== "open") throw new Error(`ACTION_ITEM_CANNOT_START:${item.status}`);
  return { ...item, status: "in_progress", version: item.version + 1 };
}

export function completeActionItem(item: ActionItem, evidence: string, now = new Date()): ActionItem {
  if (!["open", "in_progress", "blocked"].includes(item.status)) throw new Error(`ACTION_ITEM_CANNOT_COMPLETE:${item.status}`);
  if (!evidence.trim()) throw new Error("ACTION_ITEM_EVIDENCE_REQUIRED");
  return {
    ...item,
    status: "completed",
    completedAt: now.toISOString(),
    completionEvidence: evidence,
    version: item.version + 1,
  };
}

