// Requirements: PR-004, AR-002, AR-003, AR-010, SR-004, IR-001, IR-004, AC-001, AC-005, AC-006
import { describe, expect, it, vi } from "vitest";
import { TestNotificationService } from "@/src/modules/integration/application/test-notification";
import { DEMO_CONNECTION_IDS, InMemoryAcceptanceRepository } from "@/src/modules/integration/infrastructure/acceptance-repository";
import { InMemoryTestNotificationProposalRepository } from "@/src/modules/integration/infrastructure/test-notification-repository";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

const NOW = new Date("2026-08-05T00:00:00.000Z");
const RECIPIENT = "ou-sensitive-recipient-123";

async function acceptedRepository() {
  const repository = new InMemoryAcceptanceRepository();
  const connection = repository.connections.get(DEMO_CONNECTION_IDS.feishu)!;
  repository.connections.set(connection.id, { ...connection, status: "active", externalOrganizationId: "tenant-org-1" });
  await repository.appendRun({
    id: "71000000-0000-4000-8000-000000000001",
    tenantId: connection.tenantId,
    runKind: "connector",
    subjectId: connection.id,
    provider: "feishu",
    connectionId: connection.id,
    status: "passed",
    steps: ["connection", "organization_binding", "callback_secret", "token_exchange", "platform_api"].map((id) => ({ id, status: "passed" as const, summary: "passed", checkedAt: NOW.toISOString() })),
    safeEvidence: { provider: "feishu", externalOrganizationBound: true },
    initiatedBy: createDevelopmentRequestContext().actorId,
    traceId: "accepted-fixture",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
  });
  return repository;
}

describe("test notification side-effect governance", () => {
  it("stores only a recipient digest and requires a hash-bound confirmation before delivery", async () => {
    const acceptance = await acceptedRepository();
    const proposals = new InMemoryTestNotificationProposalRepository();
    const deliver = vi.fn(async () => ({
      tenantId: createDevelopmentRequestContext().tenantId,
      notificationId: "acceptance-test",
      provider: "feishu" as const,
      connectionId: DEMO_CONNECTION_IDS.feishu,
      status: "delivered" as const,
      attempts: 1,
      receipt: { externalMessageId: "om_external_receipt", acceptedAt: NOW.toISOString(), status: "accepted" as const },
    }));
    const service = new TestNotificationService(acceptance, proposals, { deliver }, () => NOW);
    const context = createDevelopmentRequestContext("test-delivery");

    const proposal = await service.prepare(context, { provider: "feishu", connectionId: DEMO_CONNECTION_IDS.feishu, recipientType: "user", externalRecipientId: RECIPIENT });
    expect(deliver).not.toHaveBeenCalled();
    expect(JSON.stringify([...proposals.proposals.values()])).not.toContain(RECIPIENT);

    await expect(service.confirm(context, proposal.id, proposal.proposalHash, "different-recipient"))
      .rejects.toThrow("CONFIRMATION_RECIPIENT_MISMATCH");
    expect(deliver).not.toHaveBeenCalled();

    const result = await service.confirm(context, proposal.id, proposal.proposalHash, RECIPIENT);
    expect(result).toMatchObject({ status: "delivered", replayed: false });
    expect(result.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(deliver).toHaveBeenCalledTimes(1);

    const repeated = await service.confirm(context, proposal.id, proposal.proposalHash, RECIPIENT);
    expect(repeated).toMatchObject({ status: "delivered", replayed: true });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("halts after an unknown delivery outcome instead of retrying the side effect", async () => {
    const acceptance = await acceptedRepository();
    const proposals = new InMemoryTestNotificationProposalRepository();
    const deliver = vi.fn(async () => { throw new Error("socket closed after write"); });
    const service = new TestNotificationService(acceptance, proposals, { deliver }, () => NOW);
    const context = createDevelopmentRequestContext("unknown-delivery");
    const proposal = await service.prepare(context, { provider: "feishu", connectionId: DEMO_CONNECTION_IDS.feishu, recipientType: "user", externalRecipientId: RECIPIENT });

    await expect(service.confirm(context, proposal.id, proposal.proposalHash, RECIPIENT))
      .resolves.toMatchObject({ status: "unknown", errorCategory: "DELIVERY_OUTCOME_UNKNOWN" });
    await expect(service.confirm(context, proposal.id, proposal.proposalHash, RECIPIENT))
      .resolves.toMatchObject({ status: "unknown", replayed: true });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("refuses to prepare a write when the connection is not active or acceptance has not passed", async () => {
    const service = new TestNotificationService(
      new InMemoryAcceptanceRepository(),
      new InMemoryTestNotificationProposalRepository(),
      { async deliver() { throw new Error("must not run"); } },
      () => NOW,
    );
    await expect(service.prepare(createDevelopmentRequestContext(), { provider: "feishu", connectionId: DEMO_CONNECTION_IDS.feishu, recipientType: "user", externalRecipientId: RECIPIENT }))
      .rejects.toThrow("INTEGRATION_CONNECTION_NOT_ACTIVE");
  });
});
