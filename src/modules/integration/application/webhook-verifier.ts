import { randomUUID } from "node:crypto";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { VerifiedRawEvent } from "@/src/modules/integration/domain/connector";
import {
  assertFreshTimestamp,
  decryptEnterpriseCallback,
  decryptFeishuPayload,
  ReplayGuard,
  verifyFeishuSignature,
  verifySha1Signature,
} from "@/src/modules/integration/security/callback-crypto";
import { parseFlatXml } from "@/src/modules/integration/security/safe-xml";

export type IncomingWebhook = {
  tenantId: string;
  connectionId: string;
  provider: ExternalProvider;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  rawBody: string;
  receivedAt?: string;
  traceId?: string;
};

export interface WebhookVerifier {
  readonly provider: ExternalProvider;
  verify(request: IncomingWebhook): VerifiedRawEvent;
}

function jsonObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAYLOAD_INVALID");
  return value as Record<string, unknown>;
}

export class FeishuWebhookVerifier implements WebhookVerifier {
  readonly provider = "feishu" as const;
  private readonly replay: ReplayGuard;

  constructor(
    private readonly config: { verificationToken: string; encryptKey: string },
    replayGuard?: ReplayGuard,
    private readonly now: () => number = () => Date.now(),
  ) { this.replay = replayGuard ?? new ReplayGuard(); }

  verify(request: IncomingWebhook): VerifiedRawEvent {
    const timestamp = request.headers["x-lark-request-timestamp"] ?? "";
    const nonce = request.headers["x-lark-request-nonce"] ?? "";
    const signature = request.headers["x-lark-signature"] ?? "";
    assertFreshTimestamp(timestamp, this.now());
    verifyFeishuSignature({ timestamp, nonce, encryptKey: this.config.encryptKey, rawBody: request.rawBody, signature });
    this.replay.claim(`${request.connectionId}:${timestamp}:${nonce}:${signature}`);
    let body = jsonObject(request.rawBody);
    if (typeof body.encrypt === "string") body = jsonObject(decryptFeishuPayload(body.encrypt, this.config.encryptKey));
    const token = String((body.header as Record<string, unknown> | undefined)?.token ?? body.token ?? "");
    if (token !== this.config.verificationToken) throw new Error("VERIFICATION_TOKEN_INVALID");
    return verified(request, body);
  }
}

export class DingtalkHttpWebhookVerifier implements WebhookVerifier {
  readonly provider = "dingtalk" as const;
  private readonly replay: ReplayGuard;

  constructor(
    private readonly config: { token: string; encodingAesKey: string; receiveId: string },
    replayGuard?: ReplayGuard,
    private readonly now: () => number = () => Date.now(),
  ) { this.replay = replayGuard ?? new ReplayGuard(); }

  verify(request: IncomingWebhook): VerifiedRawEvent {
    const timestamp = request.query.timestamp ?? "";
    const nonce = request.query.nonce ?? "";
    const signature = request.query.signature ?? request.query.msg_signature ?? "";
    assertFreshTimestamp(timestamp, this.now());
    const envelope = jsonObject(request.rawBody);
    const ciphertext = String(envelope.encrypt ?? "");
    verifySha1Signature([this.config.token, timestamp, nonce, ciphertext], signature);
    this.replay.claim(`${request.connectionId}:${timestamp}:${nonce}:${signature}`);
    const plaintext = decryptEnterpriseCallback({ ciphertext, encodingAesKey: this.config.encodingAesKey, expectedReceiveId: this.config.receiveId });
    return verified(request, jsonObject(plaintext));
  }
}

export class WecomWebhookVerifier implements WebhookVerifier {
  readonly provider = "wecom" as const;
  private readonly replay: ReplayGuard;

  constructor(
    private readonly config: { token: string; encodingAesKey: string; receiveId: string },
    replayGuard?: ReplayGuard,
    private readonly now: () => number = () => Date.now(),
  ) { this.replay = replayGuard ?? new ReplayGuard(); }

  verify(request: IncomingWebhook): VerifiedRawEvent {
    const timestamp = request.query.timestamp ?? "";
    const nonce = request.query.nonce ?? "";
    const signature = request.query.msg_signature ?? "";
    assertFreshTimestamp(timestamp, this.now());
    const envelope = parseFlatXml(request.rawBody);
    const ciphertext = envelope.Encrypt ?? request.query.echostr ?? "";
    verifySha1Signature([this.config.token, timestamp, nonce, ciphertext], signature);
    this.replay.claim(`${request.connectionId}:${timestamp}:${nonce}:${signature}`);
    const plaintext = decryptEnterpriseCallback({ ciphertext, encodingAesKey: this.config.encodingAesKey, expectedReceiveId: this.config.receiveId });
    return verified(request, parseFlatXml(plaintext));
  }

  verifyUrlChallenge(input: { timestamp: string; nonce: string; signature: string; echostr: string }): string {
    assertFreshTimestamp(input.timestamp, this.now());
    verifySha1Signature([this.config.token, input.timestamp, input.nonce, input.echostr], input.signature);
    this.replay.claim(`challenge:${input.timestamp}:${input.nonce}:${input.signature}`);
    return decryptEnterpriseCallback({ ciphertext: input.echostr, encodingAesKey: this.config.encodingAesKey, expectedReceiveId: this.config.receiveId });
  }
}

function verified(request: IncomingWebhook, body: Record<string, unknown>): VerifiedRawEvent {
  return {
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    provider: request.provider,
    transport: "http",
    receivedAt: request.receivedAt ?? new Date().toISOString(),
    rawBody: request.rawBody,
    body,
    traceId: request.traceId ?? randomUUID(),
  };
}

export function verifiedStreamEvent(input: Omit<VerifiedRawEvent, "transport" | "receivedAt" | "traceId"> & { receivedAt?: string; traceId?: string }): VerifiedRawEvent {
  return { ...input, transport: "stream", receivedAt: input.receivedAt ?? new Date().toISOString(), traceId: input.traceId ?? randomUUID() };
}
