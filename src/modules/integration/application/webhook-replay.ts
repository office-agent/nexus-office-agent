import { createHash } from "node:crypto";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { IncomingWebhook } from "@/src/modules/integration/application/webhook-verifier";

export type WebhookReplayClaim = {
  tenantId: string;
  connectionId: string;
  provider: ExternalProvider;
  fingerprint: string;
  rawDigest: string;
  receivedAt: string;
  expiresAt: string;
};

export interface WebhookReplayStore {
  claim(input: WebhookReplayClaim): Promise<{ status: "accepted" | "duplicate"; firstReceivedAt: string }>;
}

export function createWebhookReplayClaim(request: IncomingWebhook): WebhookReplayClaim {
  const timestamp = request.provider === "feishu"
    ? request.headers["x-lark-request-timestamp"] ?? ""
    : request.query.timestamp ?? "";
  const nonce = request.provider === "feishu"
    ? request.headers["x-lark-request-nonce"] ?? ""
    : request.query.nonce ?? "";
  const signature = request.provider === "feishu"
    ? request.headers["x-lark-signature"] ?? ""
    : request.query.signature ?? request.query.msg_signature ?? "";
  const rawDigest = createHash("sha256").update(request.rawBody).digest("hex");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([1, request.provider, request.connectionId, timestamp, nonce, signature, rawDigest]))
    .digest("hex");
  return {
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    provider: request.provider,
    fingerprint,
    rawDigest,
    receivedAt: request.receivedAt ?? new Date().toISOString(),
    expiresAt: new Date((Number(timestamp) < 10_000_000_000 ? Number(timestamp) * 1000 : Number(timestamp)) + 10 * 60 * 1000).toISOString(),
  };
}
