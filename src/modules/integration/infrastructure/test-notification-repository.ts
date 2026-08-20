import type { TestNotificationProposal, TestNotificationProposalRepository } from "@/src/modules/integration/application/test-notification";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { TransactionalDatabase } from "@/src/platform/database/executor";

type ProposalRow = {
  id: string;
  tenant_id: string;
  actor_id: string;
  provider: ExternalProvider;
  connection_id: string;
  acceptance_run_id: string;
  recipient_type: "user" | "chat";
  recipient_digest: string;
  message_version: number;
  proposal_hash: string;
  status: TestNotificationProposal["status"];
  result_status: TestNotificationProposal["resultStatus"] | null;
  receipt_digest: string | null;
  error_category: string | null;
  trace_id: string;
  expires_at: Date | string;
  created_at: Date | string;
  executed_at: Date | string | null;
};

function mapRow(row: ProposalRow): TestNotificationProposal {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    provider: row.provider,
    connectionId: String(row.connection_id),
    acceptanceRunId: String(row.acceptance_run_id),
    recipientType: row.recipient_type,
    recipientDigest: row.recipient_digest,
    messageVersion: Number(row.message_version),
    proposalHash: row.proposal_hash,
    status: row.status,
    resultStatus: row.result_status ?? undefined,
    receiptDigest: row.receipt_digest ?? undefined,
    errorCategory: row.error_category ?? undefined,
    traceId: row.trace_id,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    executedAt: row.executed_at ? new Date(row.executed_at).toISOString() : undefined,
  };
}

const SELECT_COLUMNS = `id::text,tenant_id::text,actor_id::text,provider,connection_id::text,acceptance_run_id::text,
  recipient_type,recipient_digest,message_version,proposal_hash,status,result_status,receipt_digest,error_category,
  trace_id,expires_at,created_at,executed_at`;

export class PostgresTestNotificationProposalRepository implements TestNotificationProposalRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async create(proposal: TestNotificationProposal): Promise<void> {
    await this.database.withTenant(proposal.tenantId, (executor) => executor.query(
      `INSERT INTO connector_test_notification_proposals(
         id,tenant_id,actor_id,provider,connection_id,acceptance_run_id,recipient_type,recipient_digest,
         message_version,proposal_hash,status,trace_id,expires_at,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13)`,
      [proposal.id,proposal.tenantId,proposal.actorId,proposal.provider,proposal.connectionId,proposal.acceptanceRunId,
        proposal.recipientType,proposal.recipientDigest,proposal.messageVersion,proposal.proposalHash,proposal.traceId,
        proposal.expiresAt,proposal.createdAt],
    ));
  }

  async get(tenantId: string, id: string): Promise<TestNotificationProposal | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<ProposalRow>(
        `SELECT ${SELECT_COLUMNS} FROM connector_test_notification_proposals WHERE tenant_id=$1 AND id=$2`,
        [tenantId,id],
      );
      return row ? mapRow(row) : null;
    });
  }

  async claim(tenantId: string, id: string): Promise<boolean> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE connector_test_notification_proposals SET status='executing'
         WHERE tenant_id=$1 AND id=$2 AND status='pending' AND expires_at>now()
         RETURNING id::text`,
        [tenantId,id],
      );
      return rows.length === 1;
    });
  }

  async finish(tenantId: string, id: string, result: Pick<TestNotificationProposal, "status" | "resultStatus" | "receiptDigest" | "errorCategory" | "executedAt">): Promise<void> {
    await this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE connector_test_notification_proposals
         SET status=$3,result_status=$4,receipt_digest=$5,error_category=$6,executed_at=$7
         WHERE tenant_id=$1 AND id=$2 AND status='executing'
         RETURNING id::text`,
        [tenantId,id,result.status,result.resultStatus??null,result.receiptDigest??null,result.errorCategory??null,result.executedAt??null],
      );
      if (rows.length !== 1) throw new Error("TEST_NOTIFICATION_PROPOSAL_STATE_CONFLICT");
    });
  }
}

export class InMemoryTestNotificationProposalRepository implements TestNotificationProposalRepository {
  readonly proposals = new Map<string, TestNotificationProposal>();

  async create(proposal: TestNotificationProposal) {
    const key = `${proposal.tenantId}:${proposal.id}`;
    if (this.proposals.has(key)) throw new Error("TEST_NOTIFICATION_PROPOSAL_CONFLICT");
    this.proposals.set(key, structuredClone(proposal));
  }

  async get(tenantId: string, id: string) {
    const proposal = this.proposals.get(`${tenantId}:${id}`);
    return proposal ? structuredClone(proposal) : null;
  }

  async claim(tenantId: string, id: string) {
    const key = `${tenantId}:${id}`;
    const proposal = this.proposals.get(key);
    if (!proposal || proposal.status !== "pending") return false;
    this.proposals.set(key, { ...proposal, status: "executing" });
    return true;
  }

  async finish(tenantId: string, id: string, result: Pick<TestNotificationProposal, "status" | "resultStatus" | "receiptDigest" | "errorCategory" | "executedAt">) {
    const key = `${tenantId}:${id}`;
    const proposal = this.proposals.get(key);
    if (!proposal || proposal.status !== "executing") throw new Error("TEST_NOTIFICATION_PROPOSAL_STATE_CONFLICT");
    this.proposals.set(key, { ...proposal, ...result });
  }
}

const runtime = globalThis as typeof globalThis & { __nexusTestNotificationProposalRepository?: InMemoryTestNotificationProposalRepository; __nexusTestNotificationProposalRepositoryVersion?: number };
export function getDevelopmentTestNotificationProposalRepository() {
  if (runtime.__nexusTestNotificationProposalRepositoryVersion !== 1) {
    runtime.__nexusTestNotificationProposalRepository = new InMemoryTestNotificationProposalRepository();
    runtime.__nexusTestNotificationProposalRepositoryVersion = 1;
  }
  return runtime.__nexusTestNotificationProposalRepository!;
}
