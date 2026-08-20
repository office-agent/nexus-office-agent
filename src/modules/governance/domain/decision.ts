export type DecisionStatus = "draft" | "under_review" | "decided" | "executing" | "verified" | "superseded" | "closed";

export type Decision = {
  id: string;
  tenantId: string;
  projectId?: string;
  riskId?: string;
  title: string;
  context: string;
  options: string[];
  selectedOption?: string;
  rationale?: string;
  ownerId: string;
  decidedBy?: string;
  status: DecisionStatus;
  reviewAt?: string;
  supersedesId?: string;
  version: number;
};

export function submitDecision(decision: Decision): Decision {
  if (decision.status !== "draft") throw new Error(`DECISION_CANNOT_SUBMIT:${decision.status}`);
  if (decision.options.length < 2) throw new Error("DECISION_OPTIONS_INSUFFICIENT");
  return { ...decision, status: "under_review", version: decision.version + 1 };
}

export function decide(
  decision: Decision,
  input: { selectedOption: string; rationale: string; decidedBy: string; reviewAt?: string },
): Decision {
  if (decision.status !== "under_review") throw new Error(`DECISION_CANNOT_DECIDE:${decision.status}`);
  if (!decision.options.includes(input.selectedOption)) throw new Error("DECISION_OPTION_UNKNOWN");
  if (!input.rationale.trim()) throw new Error("DECISION_RATIONALE_REQUIRED");
  return {
    ...decision,
    ...input,
    status: "decided",
    version: decision.version + 1,
  };
}

export function markDecisionSuperseded(decision: Decision, replacementId: string, expectedVersion: number): Decision {
  if (decision.version !== expectedVersion) throw new Error("DECISION_VERSION_CONFLICT");
  if (!["decided", "executing", "verified"].includes(decision.status)) throw new Error(`DECISION_CANNOT_SUPERSEDE:${decision.status}`);
  if (!replacementId || replacementId === decision.id) throw new Error("DECISION_REPLACEMENT_INVALID");
  return { ...decision, status: "superseded", version: decision.version + 1 };
}
