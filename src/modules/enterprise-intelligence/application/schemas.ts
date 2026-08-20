import { z } from "zod";

const uuid = z.uuid();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const metricObservationSchema = z.object({
  value: z.number().finite(),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  observedAt: z.iso.datetime({ offset: true }),
  sourceType: z.enum(["authoritative", "human_confirmed"]),
  sourceRef: text(2, 500),
  evidenceRefs: z.array(text(2, 500)).min(1).max(20),
}).refine((value) => value.periodEnd >= value.periodStart, { path: ["periodEnd"], message: "periodEnd must not precede periodStart" });

export const confirmOperatingReviewSchema = z.object({ version: z.number().int().positive() });
export const talentEvidenceSchema = z.object({
  subjectUserId: uuid,
  purpose: z.enum(["development_conversation", "performance_review"]),
});

export const responsibilitySchema = z.object({
  subjectType: z.enum(["user", "position", "governance_group"]),
  subjectId: uuid,
  role: z.enum(["accountable", "responsible", "consulted", "informed"]),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
});

export const replaceResponsibilitiesSchema = z.object({
  resourceType: z.enum(["objective", "project", "metric", "process"]),
  resourceId: uuid,
  assignments: z.array(responsibilitySchema).min(2).max(100),
});

export const capacityPlanSchema = z.object({
  userId: uuid,
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  availableHours: z.number().positive().max(744),
  allocations: z.array(z.object({
    resourceType: z.enum(["project", "operations", "learning", "leave"]),
    resourceId: uuid,
    allocationPercent: z.number().min(0).max(100),
  })).max(100),
  includedSignals: z.array(text(1, 80)).max(30),
}).refine((value) => value.periodEnd >= value.periodStart, { path: ["periodEnd"], message: "periodEnd must not precede periodStart" });
