import { z } from "zod";

export const registerClientDeviceSchema = z.object({
  installationId: z.uuid(),
  displayName: z.string().trim().min(1).max(80),
  clientType: z.enum(["web_pwa", "desktop_pwa", "mobile_pwa"]),
  platform: z.string().trim().min(1).max(80),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$/),
}).strict();

export const pushSubscriptionSchema = z.object({
  endpoint: z.url().refine((value) => new URL(value).protocol === "https:", "Push endpoint must use HTTPS"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(20).max(512), auth: z.string().min(8).max(256) }).strict(),
}).strict();
