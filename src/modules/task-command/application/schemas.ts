import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });
const priority = z.enum(["critical", "high", "medium", "low"]);
const dataClassification = z.enum(["public", "internal", "confidential", "restricted"]);
const contentDigest = z.string().regex(/^[a-f0-9]{64}$/i, "内容摘要必须是 SHA-256 十六进制值。");

export const publishMissionSchema = z.object({
  conversationId: z.uuid(),
  projectId: z.uuid().optional(),
  title: z.string().trim().min(2).max(160),
  objective: z.string().trim().min(4).max(1200),
  priority,
  dueAt: isoDateTime,
  packages: z.array(z.object({
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().min(2).max(1200),
    acceptanceCriteria: z.string().trim().min(2).max(800),
    requiredSkills: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    assignmentMode: z.enum(["direct", "open_claim"]),
    assigneeId: z.uuid().optional(),
    targetOrgUnitId: z.uuid().optional(),
    priority,
    dueAt: isoDateTime,
    capacityPoints: z.number().int().min(1).max(40).default(1),
  }).strict().superRefine((value, context) => {
    if (value.assignmentMode === "direct" && !value.assigneeId) context.addIssue({ code: "custom", path: ["assigneeId"], message: "定向分派必须指定负责人。" });
    if (value.assignmentMode === "direct" && value.targetOrgUnitId) context.addIssue({ code: "custom", path: ["targetOrgUnitId"], message: "定向个人任务不能同时指定部门。" });
    if (value.assignmentMode === "open_claim" && value.assigneeId) context.addIssue({ code: "custom", path: ["assigneeId"], message: "公开承接任务不能预设负责人。" });
  })).min(1).max(20),
}).strict();

export const claimPackageSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export const transitionPackageSchema = z.object({
  expectedVersion: z.number().int().positive(),
  nextStatus: z.enum(["published", "assigned", "claimed", "in_progress", "blocked", "in_review", "completed", "cancelled"]),
  evidenceRefs: z.array(z.string().trim().min(2).max(240)).max(20).optional(),
  blockedReason: z.string().trim().min(4).max(500).optional(),
}).strict();

export const initiateTaskHandoffSchema = z.object({
  taskId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  toAssigneeId: z.uuid(),
  note: z.string().trim().min(4).max(1_200),
  artifactIds: z.array(z.uuid()).max(40).default([]),
  /** @deprecated Only accepted while older clients move to versioned artifacts. */
  artifactRefs: z.array(z.string().trim().min(2).max(240)).max(40).default([]),
}).strict();

export const registerTaskArtifactSchema = z.object({
  title: z.string().trim().min(2).max(160),
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, "mediaType 必须是有效 MIME 类型。"),
  contentDigest,
  storageRef: z.string().trim().min(1).max(500).optional(),
  classification: dataClassification.default("internal"),
}).strict();

export const appendTaskArtifactVersionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, "mediaType 必须是有效 MIME 类型。"),
  contentDigest,
  storageRef: z.string().trim().min(1).max(500).optional(),
}).strict();

export const respondToTaskHandoffSchema = z.object({
  expectedVersion: z.number().int().positive(),
  decision: z.enum(["accept", "reject"]),
  responseNote: z.string().trim().min(4).max(800).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "reject" && !value.responseNote) context.addIssue({ code: "custom", path: ["responseNote"], message: "退回交接必须说明原因。" });
});

export const taskHandoffTrailSchema = z.object({ taskId: z.uuid() }).strict();

export const publishPoolMessageSchema = z.object({
  poolKey: z.union([z.literal("company"), z.uuid()]),
  subject: z.string().trim().min(2).max(160),
  content: z.string().trim().min(2).max(1_200),
}).strict();

export const appendPoolFeedbackSchema = z.object({
  messageId: z.uuid(),
  content: z.string().trim().min(2).max(800),
}).strict();

export type PublishMissionInput = z.infer<typeof publishMissionSchema>;
export type TransitionPackageInput = z.infer<typeof transitionPackageSchema>;
export type InitiateTaskHandoffInput = z.input<typeof initiateTaskHandoffSchema>;
export type RegisterTaskArtifactInput = z.infer<typeof registerTaskArtifactSchema>;
export type AppendTaskArtifactVersionInput = z.infer<typeof appendTaskArtifactVersionSchema>;
export type RespondToTaskHandoffInput = z.infer<typeof respondToTaskHandoffSchema>;
export type PublishPoolMessageInput = z.infer<typeof publishPoolMessageSchema>;
export type AppendPoolFeedbackInput = z.infer<typeof appendPoolFeedbackSchema>;
