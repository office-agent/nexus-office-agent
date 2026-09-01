import type { EventStore } from "@/src/modules/events/application/event-store";
import { normalizeDingtalkEvent, normalizeFeishuEvent, normalizeWecomEvent } from "@/src/modules/integration/application/event-normalizers";
import { createWebhookReplayClaim, type WebhookReplayStore } from "@/src/modules/integration/application/webhook-replay";
import { DingtalkHttpWebhookVerifier, FeishuWebhookVerifier, type IncomingWebhook, WecomWebhookVerifier } from "@/src/modules/integration/application/webhook-verifier";
import type { WebhookConnectionRepository } from "@/src/modules/integration/infrastructure/connection-repository";
import type { ConnectorSecretResolver, EnterpriseCallbackSecret, FeishuCallbackSecret } from "@/src/modules/integration/infrastructure/secret-resolver";
import { encryptEnterpriseCallback, sha1SortedSignature } from "@/src/modules/integration/security/callback-crypto";

export type WebhookIngressResult = {
  accepted: number;
  duplicates: number;
  challenge?: { provider: "feishu" | "wecom"; value: string };
  acknowledgment?: { contentType: string; body: string };
};

export class WebhookIngressService {
  constructor(
    private readonly connections: WebhookConnectionRepository,
    private readonly secrets: ConnectorSecretResolver,
    private readonly events: EventStore,
    private readonly replays: WebhookReplayStore,
  ) {}

  async receive(request: IncomingWebhook): Promise<WebhookIngressResult> {
    const connection = await this.connections.getForWebhook(request.tenantId, request.connectionId, request.provider);
    if (!connection) throw new Error("WEBHOOK_CONNECTION_NOT_FOUND");
    if (connection.transportMode && connection.transportMode !== "http") throw new Error("WEBHOOK_TRANSPORT_DISABLED");
    const trustedRequest = {
      ...request,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      provider: connection.provider,
      receivedAt: request.receivedAt ?? new Date().toISOString(),
    };
    const secret = await this.secrets.resolve(connection.secretRef, connection.provider);
    if (trustedRequest.provider === "wecom" && trustedRequest.query.echostr && !trustedRequest.rawBody) {
      const verifier = new WecomWebhookVerifier(secret as EnterpriseCallbackSecret);
      return { accepted: 0, duplicates: 0, challenge: { provider: "wecom", value: verifier.verifyUrlChallenge({ timestamp: trustedRequest.query.timestamp ?? "", nonce: trustedRequest.query.nonce ?? "", signature: trustedRequest.query.msg_signature ?? "", echostr: trustedRequest.query.echostr }) } };
    }
    const raw = trustedRequest.provider === "feishu"
      ? new FeishuWebhookVerifier(secret as FeishuCallbackSecret).verify(trustedRequest)
      : trustedRequest.provider === "dingtalk"
        ? new DingtalkHttpWebhookVerifier(secret as EnterpriseCallbackSecret).verify(trustedRequest)
        : new WecomWebhookVerifier(secret as EnterpriseCallbackSecret).verify(trustedRequest);
    if (trustedRequest.provider === "feishu" && raw.body.type === "url_verification") {
      const challenge = String(raw.body.challenge ?? "");
      if (!challenge) throw new Error("WEBHOOK_CHALLENGE_INVALID");
      return { accepted: 0, duplicates: 0, challenge: { provider: "feishu", value: challenge } };
    }
    const replay = await this.replays.claim(createWebhookReplayClaim(trustedRequest));
    const stableRaw = replay.status === "duplicate" ? { ...raw, receivedAt: replay.firstReceivedAt } : raw;
    const normalized = trustedRequest.provider === "feishu" ? normalizeFeishuEvent(stableRaw) : trustedRequest.provider === "dingtalk" ? normalizeDingtalkEvent(stableRaw) : normalizeWecomEvent(stableRaw);
    let accepted = 0; let duplicates = 0;
    for (const event of normalized) {
      if (await this.events.claimInbound(event) === "accepted") accepted += 1;
      else duplicates += 1;
    }
    return this.acknowledge(trustedRequest.provider, accepted, duplicates, secret);
  }

  private acknowledge(provider: IncomingWebhook["provider"], accepted: number, duplicates: number, secret: FeishuCallbackSecret | EnterpriseCallbackSecret): WebhookIngressResult {
    if (provider === "dingtalk") {
      const callbackSecret = secret as EnterpriseCallbackSecret;
      const timeStamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      const encrypt = encryptEnterpriseCallback({ plaintext: "success", encodingAesKey: callbackSecret.encodingAesKey, receiveId: callbackSecret.receiveId });
      const msg_signature = sha1SortedSignature([callbackSecret.token, timeStamp, nonce, encrypt]);
      return { accepted, duplicates, acknowledgment: { contentType: "application/json; charset=utf-8", body: JSON.stringify({ msg_signature, timeStamp, nonce, encrypt }) } };
    }
    if (provider === "wecom") return { accepted, duplicates, acknowledgment: { contentType: "text/plain; charset=utf-8", body: "success" } };
    return { accepted, duplicates };
  }
}
