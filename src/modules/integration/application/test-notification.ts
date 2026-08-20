import { randomUUID, timingSafeEqual } from "node:crypto";
import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { AcceptanceRepository } from "@/src/modules/integration/application/acceptance";
import type { NotificationDelivery } from "@/src/modules/integration/application/notification-router";
import { digestPayload } from "@/src/modules/events/domain/event-envelope";
import type { RequestContext } from "@/src/platform/context/request-context";

export const TEST_NOTIFICATION_MESSAGE_VERSION = 1;
export const TEST_NOTIFICATION_MESSAGE = {
  type: "info" as const,
  title: "Nexus Office 企业接入验收",
  text: "这是一条经企业管理员确认的接入测试通知。收到此消息表示出站消息链路已接受请求。",
};

export type TestNotificationProposalStatus = "pending" | "executing" | "delivered" | "failed" | "unknown" | "cancelled";

export type TestNotificationProposal = {
  id: string;
  tenantId: string;
  actorId: string;
  provider: ExternalProvider;
  connectionId: string;
  acceptanceRunId: string;
  recipientType: "user" | "chat";
  recipientDigest: string;
  messageVersion: number;
  proposalHash: string;
  status: TestNotificationProposalStatus;
  resultStatus?: "delivered" | "failed" | "unknown";
  receiptDigest?: string;
  errorCategory?: string;
  traceId: string;
  expiresAt: string;
  createdAt: string;
  executedAt?: string;
};

export interface TestNotificationProposalRepository {
  create(proposal: TestNotificationProposal): Promise<void>;
  get(tenantId: string, id: string): Promise<TestNotificationProposal | null>;
  claim(tenantId: string, id: string): Promise<boolean>;
  finish(tenantId: string, id: string, result: Pick<TestNotificationProposal, "status" | "resultStatus" | "receiptDigest" | "errorCategory" | "executedAt">): Promise<void>;
}

export interface TestNotificationGateway {
  deliver(input: {
    id: string;
    tenantId: string;
    provider: ExternalProvider;
    connectionId: string;
    recipientType: "user" | "chat";
    externalRecipientId: string;
  }): Promise<NotificationDelivery>;
}

function requirePolicy(context: RequestContext, action: "create" | "execute", id: string): void {
  const decision = evaluateAccess({ context, action, resource: { tenantId: context.tenantId, type: "integration_delivery", id } });
  if (!decision.allowed) throw new Error(`POLICY_DENIED:${decision.reason}`);
}

function proposalDigest(input: Pick<TestNotificationProposal, "id" | "tenantId" | "actorId" | "provider" | "connectionId" | "acceptanceRunId" | "recipientType" | "recipientDigest" | "messageVersion" | "expiresAt">): string {
  return digestPayload({
    id: input.id,
    tenantId: input.tenantId,
    actorId: input.actorId,
    provider: input.provider,
    connectionId: input.connectionId,
    acceptanceRunId: input.acceptanceRunId,
    recipientType: input.recipientType,
    recipientDigest: input.recipientDigest,
    messageVersion: input.messageVersion,
    expiresAt: input.expiresAt,
  });
}

function secureEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function recipientDigest(type: "user" | "chat", externalRecipientId: string): string {
  return digestPayload({ type, externalRecipientId });
}

function publicResult(proposal: TestNotificationProposal, replayed = false) {
  return {
    id: proposal.id,
    provider: proposal.provider,
    connectionId: proposal.connectionId,
    status: proposal.status,
    resultStatus: proposal.resultStatus,
    receiptDigest: proposal.receiptDigest,
    errorCategory: proposal.errorCategory,
    executedAt: proposal.executedAt,
    replayed,
  };
}

function hasCurrentConnectorEvidence(run: Awaited<ReturnType<AcceptanceRepository["latestRuns"]>>[number]): boolean {
  const required = ["connection", "organization_binding", "callback_secret", "token_exchange", "platform_api"];
  return run.status === "passed"
    && required.every((id) => run.steps.some((item) => item.id === id && item.status === "passed"))
    && run.safeEvidence.externalOrganizationBound === true;
}

export class TestNotificationService {
  constructor(
    private readonly acceptance: AcceptanceRepository,
    private readonly proposals: TestNotificationProposalRepository,
    private readonly gateway: TestNotificationGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepare(context: RequestContext, input: { provider: ExternalProvider; connectionId: string; recipientType: "user" | "chat"; externalRecipientId: string }) {
    requirePolicy(context, "create", input.connectionId);
    const connection = await this.acceptance.getConnection(context.tenantId, input.provider, input.connectionId);
    if (!connection) throw new Error("INTEGRATION_CONNECTION_NOT_FOUND");
    if (connection.status !== "active") throw new Error("INTEGRATION_CONNECTION_NOT_ACTIVE");

    const latest = (await this.acceptance.latestRuns(context.tenantId))
      .find((run) => run.runKind === "connector" && run.subjectId === connection.id);
    if (!latest || !hasCurrentConnectorEvidence(latest)) throw new Error("INTEGRATION_ACCEPTANCE_REQUIRED");

    const createdAt = this.now().toISOString();
    const proposal: TestNotificationProposal = {
      id: randomUUID(),
      tenantId: context.tenantId,
      actorId: context.actorId,
      provider: input.provider,
      connectionId: connection.id,
      acceptanceRunId: latest.id,
      recipientType: input.recipientType,
      recipientDigest: recipientDigest(input.recipientType, input.externalRecipientId),
      messageVersion: TEST_NOTIFICATION_MESSAGE_VERSION,
      proposalHash: "",
      status: "pending",
      traceId: context.traceId,
      expiresAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
      createdAt,
    };
    proposal.proposalHash = proposalDigest(proposal);
    await this.proposals.create(proposal);
    return {
      id: proposal.id,
      provider: proposal.provider,
      connectionId: proposal.connectionId,
      recipientType: proposal.recipientType,
      proposalHash: proposal.proposalHash,
      expiresAt: proposal.expiresAt,
      preview: `通过 ${connection.name} 向 1 个已核对的测试${proposal.recipientType === "user" ? "用户" : "会话"}发送固定验收通知。`,
      messageVersion: proposal.messageVersion,
    };
  }

  async confirm(context: RequestContext, id: string, proposalHash: string, externalRecipientId: string) {
    requirePolicy(context, "execute", id);
    const proposal = await this.proposals.get(context.tenantId, id);
    if (!proposal) throw new Error("TEST_NOTIFICATION_PROPOSAL_NOT_FOUND");
    if (proposal.actorId !== context.actorId) throw new Error("CONFIRMATION_ACTOR_MISMATCH");
    if (!secureEqual(proposal.proposalHash, proposalDigest(proposal))) throw new Error("PROPOSAL_INTEGRITY_VIOLATION");
    if (!secureEqual(proposal.proposalHash, proposalHash)) throw new Error("CONFIRMATION_HASH_MISMATCH");
    if (!secureEqual(proposal.recipientDigest, recipientDigest(proposal.recipientType, externalRecipientId))) throw new Error("CONFIRMATION_RECIPIENT_MISMATCH");
    if (new Date(proposal.expiresAt).getTime() <= this.now().getTime()) throw new Error("PROPOSAL_EXPIRED");
    if (!["pending", "executing"].includes(proposal.status)) return publicResult(proposal, true);

    const connection = await this.acceptance.getConnection(context.tenantId, proposal.provider, proposal.connectionId);
    if (!connection || connection.status !== "active") throw new Error("INTEGRATION_CONNECTION_NOT_ACTIVE");
    const latest = (await this.acceptance.latestRuns(context.tenantId))
      .find((run) => run.runKind === "connector" && run.subjectId === proposal.connectionId);
    if (!latest || !hasCurrentConnectorEvidence(latest) || latest.id !== proposal.acceptanceRunId) throw new Error("CONFIRMATION_ACCEPTANCE_CHANGED");

    const claimed = await this.proposals.claim(context.tenantId, proposal.id);
    if (!claimed) {
      const current = await this.proposals.get(context.tenantId, proposal.id);
      if (!current) throw new Error("TEST_NOTIFICATION_PROPOSAL_NOT_FOUND");
      return publicResult(current, true);
    }

    const executedAt = this.now().toISOString();
    try {
      const delivery = await this.gateway.deliver({
        id: `acceptance-test:${proposal.id}`,
        tenantId: context.tenantId,
        provider: proposal.provider,
        connectionId: proposal.connectionId,
        recipientType: proposal.recipientType,
        externalRecipientId,
      });
      const status = delivery.status === "delivered" ? "delivered" : delivery.status === "failed" ? "failed" : "unknown";
      const result: TestNotificationProposal = {
        ...proposal,
        status,
        resultStatus: status,
        receiptDigest: delivery.receipt?.externalMessageId ? digestPayload(delivery.receipt.externalMessageId) : undefined,
        errorCategory: delivery.errorCategory,
        executedAt,
      };
      await this.proposals.finish(context.tenantId, proposal.id, result);
      return publicResult(result);
    } catch {
      const result: TestNotificationProposal = { ...proposal, status: "unknown", resultStatus: "unknown", errorCategory: "DELIVERY_OUTCOME_UNKNOWN", executedAt };
      await this.proposals.finish(context.tenantId, proposal.id, result);
      return publicResult(result);
    }
  }
}
