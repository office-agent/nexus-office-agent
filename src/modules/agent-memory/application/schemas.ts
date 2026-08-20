import { z } from "zod";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const sourceRef = text(2, 300);

export const createLongTermMemorySchema = z.object({
  summary: text(2, 2_000),
  scopeType: z.enum(["user", "project", "tenant"]).default("user"),
  scopeId: z.uuid().optional(),
  visibility: z.enum(["private", "shared"]).default("private"),
  classification: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
  importance: z.number().int().min(0).max(100).default(50),
  confidence: z.number().int().min(0).max(100).default(100),
  sourceRefs: z.array(sourceRef).max(40).default([]),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

export const recallMemorySchema = z.object({
  query: text(1, 400).optional(),
  limit: z.number().int().min(1).max(20).default(8),
  includeShared: z.boolean().default(true),
}).strict();
