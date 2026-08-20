export type RiskStatus = "identified" | "assessed" | "response_planned" | "monitoring" | "realized" | "closed" | "accepted";

export type Risk = {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  description: string;
  ownerId: string;
  probability: 1 | 2 | 3 | 4 | 5;
  impact: 1 | 2 | 3 | 4 | 5;
  status: RiskStatus;
  responseStrategy?: "avoid" | "mitigate" | "transfer" | "accept";
  responsePlan?: string;
  reviewAt?: string;
  sourceType: "human" | "agent" | "event" | "import";
  sourceRef?: string;
  version: number;
};

export function riskExposure(risk: Risk): number {
  return risk.probability * risk.impact;
}

export function planRiskResponse(
  risk: Risk,
  input: { strategy: NonNullable<Risk["responseStrategy"]>; plan: string; reviewAt: string },
): Risk {
  if (!input.plan.trim()) throw new Error("RISK_RESPONSE_PLAN_REQUIRED");
  if (!["identified", "assessed"].includes(risk.status)) throw new Error(`RISK_CANNOT_PLAN_RESPONSE:${risk.status}`);
  return {
    ...risk,
    status: "response_planned",
    responseStrategy: input.strategy,
    responsePlan: input.plan,
    reviewAt: input.reviewAt,
    version: risk.version + 1,
  };
}

export function transitionRisk(risk: Risk, next: RiskStatus): Risk {
  const transitions: Record<RiskStatus, RiskStatus[]> = {
    identified: ["assessed", "accepted", "closed"],
    assessed: ["response_planned", "accepted", "closed", "realized"],
    response_planned: ["monitoring", "realized", "closed"],
    monitoring: ["realized", "closed", "accepted"],
    realized: ["closed"],
    accepted: ["realized", "closed"],
    closed: [],
  };
  if (!transitions[risk.status].includes(next)) throw new Error(`RISK_INVALID_TRANSITION:${risk.status}:${next}`);
  return { ...risk, status: next, version: risk.version + 1 };
}

