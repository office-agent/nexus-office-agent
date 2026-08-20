// Requirements: IR-003, IR-004, SR-003, SR-005, AC-003, AC-005, AC-008
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DingtalkHttpWebhookVerifier, FeishuWebhookVerifier, WecomWebhookVerifier } from "@/src/modules/integration/application/webhook-verifier";
import { normalizeDingtalkEvent, normalizeFeishuEvent, normalizeWecomEvent } from "@/src/modules/integration/application/event-normalizers";
import { ConnectorSecurityError, encryptEnterpriseCallbackFixture, sha1SortedSignature } from "@/src/modules/integration/security/callback-crypto";
import { buildEncryptedXml } from "@/src/modules/integration/security/safe-xml";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { WebhookIngressService } from "@/src/modules/integration/application/webhook-ingress";
import type { ConnectorSecretResolver } from "@/src/modules/integration/infrastructure/secret-resolver";

const NOW = Date.parse("2026-08-05T00:00:00.000Z");
const timestamp = String(NOW / 1000);
const aesKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64").slice(0, 43);

describe("connector callback security", () => {
  it("verifies Feishu signature, token and normalizes a message", () => {
    const token = ["verification", "fixture"].join("-");
    const encryptKey = ["encrypt", "fixture"].join("-");
    const body = JSON.stringify({ schema: "2.0", header: { event_id: "evt-f-1", event_type: "im.message.receive_v1", create_time: String(NOW), token }, event: { sender: { sender_id: { open_id: "ou-1" } }, message: { message_id: "m-1", chat_id: "c-1", content: "{\"text\":\"hello\"}" } } });
    const nonce = "nonce-f-1";
    const signature = createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${body}`).digest("hex");
    const verifier = new FeishuWebhookVerifier({ verificationToken: token, encryptKey }, undefined, () => NOW);
    const raw = verifier.verify({ tenantId: "tenant-a", connectionId: "connection-a", provider: "feishu", headers: { "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce, "x-lark-signature": signature }, query: {}, rawBody: body, receivedAt: new Date(NOW).toISOString(), traceId: "trace-f-1" });
    const [event] = normalizeFeishuEvent(raw);
    expect(event).toMatchObject({ eventId: "evt-f-1", eventType: "message.received", externalActor: { id: "ou-1" }, externalContext: { chatId: "c-1", messageId: "m-1" } });
    expect(() => verifier.verify({ tenantId: "tenant-a", connectionId: "connection-a", provider: "feishu", headers: { "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce, "x-lark-signature": signature }, query: {}, rawBody: body })).toThrowError(ConnectorSecurityError);
  });

  it("verifies and decrypts a DingTalk HTTP callback", () => {
    const token = ["ding", "token", "fixture"].join("-");
    const receiveId = "ding-org-fixture";
    const plaintext = JSON.stringify({ eventId: "evt-d-1", eventType: "user.change", senderStaffId: "staff-1", createTime: NOW });
    const encrypt = encryptEnterpriseCallbackFixture({ plaintext, encodingAesKey: aesKey, receiveId });
    const nonce = "nonce-d-1";
    const signature = sha1SortedSignature([token, timestamp, nonce, encrypt]);
    const verifier = new DingtalkHttpWebhookVerifier({ token, encodingAesKey: aesKey, receiveId }, undefined, () => NOW);
    const raw = verifier.verify({ tenantId: "tenant-a", connectionId: "connection-d", provider: "dingtalk", headers: {}, query: { timestamp, nonce, signature }, rawBody: JSON.stringify({ encrypt }), receivedAt: new Date(NOW).toISOString(), traceId: "trace-d-1" });
    const [event] = normalizeDingtalkEvent(raw);
    expect(event.eventType).toBe("user.changed");
    expect(event.externalActor?.id).toBe("staff-1");
  });

  it("verifies WeCom URL challenge and encrypted XML event", () => {
    const token = ["wecom", "token", "fixture"].join("-");
    const receiveId = "corp-fixture";
    const verifier = new WecomWebhookVerifier({ token, encodingAesKey: aesKey, receiveId }, undefined, () => NOW);
    const challenge = encryptEnterpriseCallbackFixture({ plaintext: "challenge-ok", encodingAesKey: aesKey, receiveId });
    expect(verifier.verifyUrlChallenge({ timestamp, nonce: "nonce-c", signature: sha1SortedSignature([token, timestamp, "nonce-c", challenge]), echostr: challenge })).toBe("challenge-ok");

    const plaintext = "<xml><ToUserName><![CDATA[corp-fixture]]></ToUserName><FromUserName><![CDATA[user-w-1]]></FromUserName><CreateTime>1785888000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content><MsgId>msg-w-1</MsgId><AgentID>1000002</AgentID></xml>";
    const encrypt = encryptEnterpriseCallbackFixture({ plaintext, encodingAesKey: aesKey, receiveId });
    const nonce = "nonce-w-1";
    const signature = sha1SortedSignature([token, timestamp, nonce, encrypt]);
    const raw = verifier.verify({ tenantId: "tenant-a", connectionId: "connection-w", provider: "wecom", headers: {}, query: { timestamp, nonce, msg_signature: signature }, rawBody: buildEncryptedXml(encrypt), receivedAt: new Date(NOW).toISOString(), traceId: "trace-w-1" });
    const [event] = normalizeWecomEvent(raw);
    expect(event).toMatchObject({ eventId: "msg-w-1", eventType: "message.received", externalActor: { id: "user-w-1" } });
  });

  it("rejects stale callbacks before normalization", () => {
    const verifier = new FeishuWebhookVerifier({ verificationToken: "unused", encryptKey: "unused" }, undefined, () => NOW);
    expect(() => verifier.verify({ tenantId: "tenant-a", connectionId: "connection-a", provider: "feishu", headers: { "x-lark-request-timestamp": "1", "x-lark-request-nonce": "n", "x-lark-signature": "bad" }, query: {}, rawBody: "{}" })).toThrowError("TIMESTAMP_STALE");
  });

  it("normalizes card callbacks to minimal trusted references", () => {
    const [event] = normalizeFeishuEvent({ tenantId: "tenant-a", connectionId: "connection-a", provider: "feishu", transport: "stream", receivedAt: new Date(NOW).toISOString(), rawBody: "fixture", traceId: "trace-card", body: { header: { event_id: "card-1", event_type: "card.action.trigger", create_time: String(NOW) }, event: { operator: { open_id: "ou-1" }, action: { value: { action_id: "agent.confirm:proposal-1", proposal_hash: "hash-1", expires_at: "2099-01-01T00:00:00.000Z", forged_amount: 999999 } } } } });
    expect(event.payload).toEqual({ actionId: "agent.confirm:proposal-1", proposalHash: "hash-1", expiresAt: "2099-01-01T00:00:00.000Z" });
  });

  it("returns the Feishu URL challenge only after signature and token verification", async () => {
    const token = ["challenge", "token"].join("-");
    const encryptKey = ["challenge", "key"].join("-");
    const body = JSON.stringify({ type: "url_verification", token, challenge: "challenge-value" });
    const nonce = "nonce-challenge";
    const ingressTimestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHash("sha256").update(`${ingressTimestamp}${nonce}${encryptKey}${body}`).digest("hex");
    const service = new WebhookIngressService(
      { async getForWebhook() { return { id: "connection-f", tenantId: "tenant-a", provider: "feishu", status: "active", secretRef: "fixture-ref", transportMode: "http" }; } },
      { async resolve() { return { verificationToken: token, encryptKey }; } } satisfies ConnectorSecretResolver,
      new InMemoryEventStore(),
    );
    const result = await service.receive({ tenantId: "tenant-a", connectionId: "connection-f", provider: "feishu", headers: { "x-lark-request-timestamp": ingressTimestamp, "x-lark-request-nonce": nonce, "x-lark-signature": signature }, query: {}, rawBody: body, receivedAt: new Date(NOW).toISOString(), traceId: "trace-challenge" });
    expect(result.challenge).toEqual({ provider: "feishu", value: "challenge-value" });
  });

  it("returns an encrypted DingTalk success acknowledgment after durable claim", async () => {
    const token = ["ding", "ack", "token"].join("-");
    const receiveId = "ding-ack-org";
    const plaintext = JSON.stringify({ eventId: "evt-d-ack", eventType: "user.change", createTime: NOW });
    const encrypt = encryptEnterpriseCallbackFixture({ plaintext, encodingAesKey: aesKey, receiveId });
    const nonce = "nonce-d-ack";
    const ingressTimestamp = String(Math.floor(Date.now() / 1000));
    const signature = sha1SortedSignature([token, ingressTimestamp, nonce, encrypt]);
    const events = new InMemoryEventStore();
    const service = new WebhookIngressService(
      { async getForWebhook() { return { id: "connection-d", tenantId: "tenant-a", provider: "dingtalk", status: "active", secretRef: "fixture-ref", transportMode: "http" }; } },
      { async resolve() { return { token, encodingAesKey: aesKey, receiveId }; } },
      events,
    );
    const result = await service.receive({ tenantId: "tenant-a", connectionId: "connection-d", provider: "dingtalk", headers: {}, query: { timestamp: ingressTimestamp, nonce, signature }, rawBody: JSON.stringify({ encrypt }), receivedAt: new Date(NOW).toISOString(), traceId: "trace-d-ack" });
    expect(result.accepted).toBe(1);
    expect(result.acknowledgment?.contentType).toContain("application/json");
    expect(JSON.parse(result.acknowledgment!.body)).toEqual(expect.objectContaining({ msg_signature: expect.any(String), encrypt: expect.any(String) }));
  });
});
