import type {
  PiGateAttestation,
  PiReleaseApproval,
  PiReleaseEvaluation,
  PiReleaseGateEvaluation,
  PiReleaseGovernanceEvent,
  PiReleaseGovernanceSnapshot,
  PiReleaseRisk,
  PiPublication,
  PiRollout,
} from "@/src/modules/pi-agent/domain/release-governance-contracts";

function withoutInternal<T extends Record<string, unknown>>(value: T, fields: string[]): Omit<T, keyof T> & Record<string, unknown> {
  const copy = { ...value } as Record<string, unknown>;
  for (const field of fields) delete copy[field];
  return copy as Omit<T, keyof T> & Record<string, unknown>;
}

export function presentPublication(item: PiPublication) { return withoutInternal(item, ["tenantId", "createdBy"]); }
export function presentGate(item: PiGateAttestation) { return withoutInternal(item, ["tenantId", "createdBy"]); }
export function presentRisk(item: PiReleaseRisk) { return withoutInternal(item, ["tenantId", "createdBy"]); }
export function presentApproval(item: PiReleaseApproval) { return withoutInternal(item, ["tenantId", "actorId"]); }
export function presentRollout(item: PiRollout) { return withoutInternal(item, ["tenantId"]); }
export function presentReleaseEvaluation(item: PiReleaseEvaluation) { return withoutInternal(item, ["tenantId"]); }
export function presentGateEvaluation(item: PiReleaseGateEvaluation) { return withoutInternal(item, ["tenantId", "actorId"]); }
export function presentReleaseEvent(item: PiReleaseGovernanceEvent) { return withoutInternal(item, ["tenantId", "actorId"]); }

export function presentReleaseGovernance(snapshot: PiReleaseGovernanceSnapshot) {
  return {
    publications: snapshot.publications.map(presentPublication),
    gates: snapshot.gates.map(presentGate),
    risks: snapshot.risks.map(presentRisk),
    approvals: snapshot.approvals.map(presentApproval),
    rollouts: snapshot.rollouts.map(presentRollout),
    evaluations: snapshot.evaluations.map(presentReleaseEvaluation),
    gateEvaluations: snapshot.gateEvaluations.map(presentGateEvaluation),
    events: snapshot.events.map(presentReleaseEvent),
    generatedAt: snapshot.generatedAt,
  };
}
