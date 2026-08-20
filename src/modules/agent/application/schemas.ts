import { z } from "zod";

export const createAgentRunSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  contextRefs: z.array(z.string().trim().min(1).max(160)).max(20).optional(),
  clientRequestId: z.string().trim().min(8).max(160).optional(),
  conversationId: z.uuid().optional(),
});

export const confirmProposalSchema = z.object({
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const controlAgentJobSchema = z.object({
  requestId: z.uuid(),
  action: z.enum(["cancel", "retry", "mark_succeeded", "mark_failed", "record_compensated"]),
  reason: z.string().trim().min(8).max(500),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  evidenceSummary: z.string().trim().min(4).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.action !== "cancel" && !value.evidenceDigest) {
    context.addIssue({ code: "custom", path: ["evidenceDigest"], message: "人工核对操作必须附带证据摘要。" });
  }
});
