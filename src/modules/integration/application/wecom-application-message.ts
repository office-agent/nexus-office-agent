import { z } from "zod";
import type { AcceptanceRepository } from "@/src/modules/integration/application/acceptance";
import type { RequestContext } from "@/src/platform/context/request-context";

export const wecomApplicationMessageSchema = z.object({
  recipientName: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(1000),
}).strict();

export type WecomApplicationMessage = z.infer<typeof wecomApplicationMessageSchema>;

export type WecomApplicationMessageReceipt = {
  status: "accepted";
  recipientName: string;
  receiptDigest: string;
  sentAt: string;
  secretExposed: false;
};

export interface WecomApplicationMessageGateway {
  resolveAndSend(input: {
    tenantId: string;
    connectionId: string;
    recipientName: string;
    text: string;
    idempotencyKey: string;
  }): Promise<WecomApplicationMessageReceipt>;
}

function hasPermission(context: RequestContext, required: string): boolean {
  const [resource, action] = required.split(":");
  return context.permissions.some((permission) => permission === "*" || permission === required || permission === `${resource}:*` || permission === `*:${action}`);
}

export class WecomApplicationMessageService {
  constructor(
    private readonly connections: AcceptanceRepository,
    private readonly gateway: WecomApplicationMessageGateway,
  ) {}

  async send(
    context: RequestContext,
    connectionId: string,
    message: WecomApplicationMessage,
    idempotencyKey: string,
  ): Promise<WecomApplicationMessageReceipt> {
    if (!hasPermission(context, "wecom_message:send")) throw new Error("POLICY_DENIED:wecom_message:send");
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const input = wecomApplicationMessageSchema.parse(message);
    const connection = await this.connections.getConnection(context.tenantId, "wecom", connectionId);
    if (!connection) throw new Error("INTEGRATION_CONNECTION_NOT_FOUND");
    if (connection.status !== "active") throw new Error("WECOM_CONNECTION_NOT_ACTIVE");
    return this.gateway.resolveAndSend({
      tenantId: context.tenantId,
      connectionId,
      recipientName: input.recipientName,
      text: input.text,
      idempotencyKey,
    });
  }
}
