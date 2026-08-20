import { z } from "zod";

const uuid = z.uuid();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const baselinePatch = z.object({
  name: text(2, 160).optional(),
  description: z.string().trim().max(4000).optional(),
  businessValue: text(3, 2000).optional(),
  acceptanceCriteria: text(3, 2000).optional(),
  resourcePlan: z.record(z.string(), z.unknown()).optional(),
  startsAt: z.iso.date().optional(),
  targetEndAt: z.iso.date().optional(),
  budget: z.number().nonnegative().optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "变更至少包含一个基线字段");

export const createOrganizationChangeSchema = z.object({
  subjectUserId: uuid,
  changeType: z.enum(["transfer", "departure"]),
  effectiveAt: z.iso.datetime({ offset: true }),
  fromOrgUnitId: uuid.optional(),
  toOrgUnitId: uuid.optional(),
  successorUserId: uuid.optional(),
  reason: text(3, 1000),
}).strict().superRefine((value, context) => {
  if (value.subjectUserId === value.successorUserId) context.addIssue({ code: "custom", path: ["successorUserId"], message: "继任人与变更对象不能相同" });
  if (value.changeType === "transfer" && !value.toOrgUnitId) context.addIssue({ code: "custom", path: ["toOrgUnitId"], message: "转岗必须指定目标组织" });
});

export const versionSchema = z.object({ version: z.number().int().positive() }).strict();

export const createProjectChangeSchema = z.object({
  projectId: uuid,
  changeType: z.enum(["scope", "schedule", "budget", "resource", "quality"]),
  proposedBaseline: baselinePatch,
  reason: text(3, 2000),
  impactAssessment: text(3, 3000),
}).strict();

const unresolvedItem = z.object({
  resourceType: z.enum(["task", "issue", "action_item", "risk"]),
  resourceId: uuid,
  handoffOwnerId: uuid,
  evidenceRef: text(3, 500),
}).strict();

export const saveClosureReviewSchema = z.object({
  deliveryAcceptanceRef: text(3, 500),
  unresolvedItems: z.array(unresolvedItem).max(100),
  retrospectiveRef: text(3, 500),
}).strict();

export const scanAttentionSchema = z.object({ now: z.iso.datetime({ offset: true }).optional() }).strict();

export const createInitiativeSchema = z.object({
  objective: z.object({
    title: text(3, 160), description: text(3, 2000), ownerId: uuid,
    baseline: z.number(), targetValue: z.number(), currentValue: z.number(), unit: text(1, 40),
    startsAt: z.iso.date(), endsAt: z.iso.date(), reviewCadence: z.enum(["daily", "weekly", "monthly", "quarterly"]),
  }).strict(),
  project: z.object({
    code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).transform((value) => value.toUpperCase()),
    name: text(2, 160), description: z.string().trim().max(4000), ownerId: uuid,
    businessValue: text(3, 2000), acceptanceCriteria: text(3, 2000), resourcePlan: z.record(z.string(), z.unknown()),
    priority: z.enum(["critical", "high", "medium", "low"]), startsAt: z.iso.date(), targetEndAt: z.iso.date(),
    budget: z.number().nonnegative().optional(), currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.objective.endsAt < value.objective.startsAt) context.addIssue({ code: "custom", path: ["objective", "endsAt"], message: "目标结束日期不得早于开始日期" });
  if (value.objective.targetValue === value.objective.baseline) context.addIssue({ code: "custom", path: ["objective", "targetValue"], message: "目标值必须与基线不同" });
  if (value.project.targetEndAt < value.project.startsAt) context.addIssue({ code: "custom", path: ["project", "targetEndAt"], message: "项目结束日期不得早于开始日期" });
  if ((value.project.budget === undefined) !== (value.project.currency === undefined)) context.addIssue({ code: "custom", path: ["project", "currency"], message: "预算与币种必须同时提供" });
});
