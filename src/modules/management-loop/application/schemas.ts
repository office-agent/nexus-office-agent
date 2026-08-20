import { z } from "zod";

const uuid = z.uuid();
const nonBlank = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum);
const riskScore = z.coerce.number().pipe(
  z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
);

export const identifyRiskSchema = z.object({
  projectId: uuid,
  title: nonBlank(3, 120),
  description: nonBlank(3, 1000),
  ownerId: uuid,
  probability: riskScore,
  impact: riskScore,
  sourceType: z.enum(["human", "agent", "event", "import"]).default("human"),
  sourceRef: z.string().trim().max(240).optional(),
});

export const recordDecisionSchema = z
  .object({
    projectId: uuid,
    riskId: uuid.optional(),
    title: nonBlank(3, 160),
    decisionContext: nonBlank(3, 2000),
    options: z.array(nonBlank(1, 300)).min(2).max(8),
    selectedOption: nonBlank(1, 300),
    rationale: nonBlank(3, 2000),
    actionItems: z
      .array(
        z.object({
          title: nonBlank(3, 160),
          ownerId: uuid,
          dueAt: z.iso.datetime({ offset: true }),
          acceptanceCriteria: nonBlank(3, 1000),
        }),
      )
      .min(1)
      .max(20),
  })
  .superRefine((value, context) => {
    if (new Set(value.options).size !== value.options.length) {
      context.addIssue({ code: "custom", path: ["options"], message: "决策选项不可重复" });
    }
    if (!value.options.includes(value.selectedOption)) {
      context.addIssue({ code: "custom", path: ["selectedOption"], message: "所选方案必须来自候选方案" });
    }
  });

export const completeActionSchema = z.object({
  evidence: nonBlank(3, 2000),
});

export const transitionTaskSchema = z.object({
  status: z.enum(["todo", "in_progress", "blocked", "in_review", "completed", "cancelled"]),
});

export const reportIssueSchema = z.object({
  projectId: uuid,
  riskId: uuid.optional(),
  title: nonBlank(3, 160),
  description: nonBlank(3, 2000),
  ownerId: uuid,
  severity: z.enum(["critical", "high", "medium", "low"]),
});

export const supersedeDecisionSchema = z.object({
  version: z.number().int().positive(),
  title: nonBlank(3, 160),
  decisionContext: nonBlank(3, 2000),
  options: z.array(nonBlank(1, 300)).min(2).max(8),
  selectedOption: nonBlank(1, 300),
  rationale: nonBlank(3, 2000),
  reviewAt: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.options).size !== value.options.length) context.addIssue({ code: "custom", path: ["options"], message: "决策选项不可重复" });
  if (!value.options.includes(value.selectedOption)) context.addIssue({ code: "custom", path: ["selectedOption"], message: "所选方案必须来自候选方案" });
});
