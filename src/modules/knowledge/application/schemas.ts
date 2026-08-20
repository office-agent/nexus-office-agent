import { z } from "zod";

export const publishDocumentSchema = z.object({
  documentId: z.uuid().optional(),
  title: z.string().trim().min(2).max(180),
  content: z.string().trim().min(1).max(200_000),
  classification: z.enum(["public","internal","confidential","restricted"]),
  allowedUserIds: z.array(z.uuid()).max(500).optional(),
  allowedRoleCodes: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  projectIds: z.array(z.uuid()).max(100).optional(),
  agentIndexingAllowed: z.boolean().optional(),
  sourceRef: z.string().trim().max(500).optional(),
  effectiveAt: z.iso.datetime({ offset: true }).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
