export type PerformanceFact = {
  id: string;
  tenantId: string;
  subjectUserId: string;
  sourceType: "objective" | "project" | "responsibility" | "feedback" | "development";
  sourceId: string;
  statement: string;
  evidenceRefs: string[];
  factType: "fact" | "human_confirmed_feedback";
  effectiveAt: string;
  classification: "confidential" | "restricted";
  visibleToIds: string[];
};

export type TalentRecord = {
  id: string;
  tenantId: string;
  subjectUserId: string;
  recordType: "development_goal" | "feedback" | "one_to_one" | "talent_label";
  content: string;
  participantIds: string[];
  agentEligible: boolean;
  classification: "confidential" | "restricted";
  effectiveAt: string;
};

export type TalentEvidencePack = {
  subjectUserId: string;
  purpose: "development_conversation" | "performance_review";
  evidence: PerformanceFact[];
  usedDataScopes: string[];
  excludedDataScopes: string[];
  gaps: string[];
  stateChanged: false;
  score: null;
  rank: null;
  employmentRecommendation: null;
};

export function buildTalentEvidencePack(input: {
  subjectUserId: string;
  purpose: TalentEvidencePack["purpose"];
  facts: PerformanceFact[];
  records: TalentRecord[];
  actorId: string;
}): TalentEvidencePack {
  const evidence = input.facts.filter((fact) =>
    fact.subjectUserId === input.subjectUserId &&
    fact.visibleToIds.includes(input.actorId),
  );
  const eligibleDevelopmentRecords = input.records.filter((record) =>
    record.subjectUserId === input.subjectUserId && record.participantIds.includes(input.actorId) && record.agentEligible && record.recordType !== "one_to_one" && record.recordType !== "talent_label",
  );
  return {
    subjectUserId: input.subjectUserId,
    purpose: input.purpose,
    evidence,
    usedDataScopes: [...new Set([...evidence.map(({ sourceType }) => sourceType), ...eligibleDevelopmentRecords.map(({ recordType }) => recordType)])],
    excludedDataScopes: ["one_to_one", "talent_label", "online_time", "message_count", "private_chat_frequency"],
    gaps: evidence.length === 0 ? ["当前权限范围内没有可核验的绩效事实。"] : [],
    stateChanged: false,
    score: null,
    rank: null,
    employmentRecommendation: null,
  };
}
