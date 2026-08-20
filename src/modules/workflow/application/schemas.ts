import { z } from "zod";

const uuid = z.uuid();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const approvalNode = z.object({
  key: text(1, 80), type: z.literal("approval"), name: text(1, 120),
  approverIds: z.array(uuid).min(1).max(50), mode: z.enum(["any", "all"]),
  next: text(1, 80), slaHours: z.number().int().min(1).max(24 * 30),
  escalationApproverIds: z.array(uuid).min(1).max(20).optional(),
});
const conditionNode = z.object({
  key: text(1, 80), type: z.literal("condition"), name: text(1, 120), field: text(1, 120),
  operator: z.enum(["eq", "neq", "gte", "lte", "contains"]), value: z.union([z.string(), z.number(), z.boolean()]),
  whenTrue: text(1, 80), whenFalse: text(1, 80),
});
const endNode = z.object({ key: text(1, 80), type: z.literal("end"), name: text(1, 120), outcome: z.enum(["approved", "rejected"]) });

export const publishProcessDefinitionSchema = z.object({
  definitionId: uuid.optional(), code: text(2, 50), name: text(2, 120), description: z.string().trim().max(1000).optional(),
  startNodeKey: text(1, 80), nodes: z.array(z.discriminatedUnion("type", [approvalNode, conditionNode, endNode])).min(2).max(100),
});

export const startProcessSchema = z.object({
  definitionId: uuid, title: text(2, 160), form: z.record(z.string(), z.unknown()),
  riskLevel: z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3),z.literal(4)]),
});

export const decideApprovalSchema = z.object({
  decision: z.enum(["approve", "reject"]), comment: z.string().trim().max(2000).default(""), version: z.number().int().positive(),
});
export const delegateApprovalSchema = z.object({ delegateId: uuid, version: z.number().int().positive() });
export const addApproverSchema = z.object({ approverId: uuid });
export const versionSchema = z.object({ version: z.number().int().positive() });
export const withdrawProcessSchema = z.object({ version: z.number().int().positive(), reason: text(2, 1000) });
export const escalateOverdueSchema = z.object({
  now: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
