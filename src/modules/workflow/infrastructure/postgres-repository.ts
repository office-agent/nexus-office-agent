import type { TransactionalDatabase } from "@/src/platform/database/executor";
import type { WorkflowRepository, WorkflowSnapshot } from "@/src/modules/workflow/application/contracts";
import type { Approval, ProcessDefinition, ProcessDefinitionVersion, ProcessInstance, ProcessNode } from "@/src/modules/workflow/domain/process";

type Row = Record<string, unknown>;
const asText = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalText = (value: unknown) => value === null || value === undefined ? undefined : asText(value);
function asJson<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }

function mapDefinition(row: Row): ProcessDefinition {
  return {
    id: asText(row.id), tenantId: asText(row.tenant_id), code: asText(row.code), name: asText(row.name),
    description: asText(row.description), ownerId: asText(row.owner_id), status: row.status as ProcessDefinition["status"],
    currentVersion: Number(row.current_version), version: Number(row.version),
  };
}

function mapDefinitionVersion(row: Row): ProcessDefinitionVersion {
  return {
    id: asText(row.id), tenantId: asText(row.tenant_id), definitionId: asText(row.definition_id),
    version: Number(row.version), startNodeKey: asText(row.start_node_key), nodes: asJson<ProcessNode[]>(row.nodes),
    publishedBy: asText(row.published_by), publishedAt: asText(row.published_at),
  };
}

function mapInstance(row: Row): ProcessInstance {
  return {
    id: asText(row.id), tenantId: asText(row.tenant_id), definitionId: asText(row.definition_id),
    definitionVersion: Number(row.definition_version), requesterId: asText(row.requester_id), title: asText(row.title),
    formSnapshot: asJson<Record<string, unknown>>(row.form_snapshot), status: row.status as ProcessInstance["status"],
    currentNodeKey: asText(row.current_node_key), riskLevel: Number(row.risk_level) as ProcessInstance["riskLevel"],
    slaDueAt: optionalText(row.sla_due_at), completedAt: optionalText(row.completed_at), version: Number(row.version),
    createdAt: asText(row.created_at),
  };
}

function mapApproval(row: Row): Approval {
  return {
    id: asText(row.id), tenantId: asText(row.tenant_id), instanceId: asText(row.instance_id), nodeKey: asText(row.node_key),
    approverId: asText(row.approver_id), requestedBy: asText(row.requested_by), status: row.status as Approval["status"],
    decision: row.decision as Approval["decision"], comment: optionalText(row.comment), delegatedFromId: optionalText(row.delegated_from_id),
    delegatedToId: optionalText(row.delegated_to_id), escalatedFromId: optionalText(row.escalated_from_id),
    escalationLevel: row.escalation_level === null || row.escalation_level === undefined ? undefined : Number(row.escalation_level),
    dueAt: asText(row.due_at), decidedAt: optionalText(row.decided_at), version: Number(row.version),
  };
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getDefinition(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM process_definitions WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
      return rows[0] ? mapDefinition(rows[0]) : null;
    });
  }

  async getDefinitionVersion(tenantId: string, definitionId: string, version: number) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM process_definition_versions WHERE tenant_id=$1 AND definition_id=$2 AND version=$3", [tenantId, definitionId, version]);
      return rows[0] ? mapDefinitionVersion(rows[0]) : null;
    });
  }

  async savePublishedDefinition(definition: ProcessDefinition, version: ProcessDefinitionVersion): Promise<void> {
    await this.database.withTenant(definition.tenantId, async (executor) => {
      await executor.query(
        `INSERT INTO process_definitions(id,tenant_id,code,name,description,owner_id,status,current_version,version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,description=EXCLUDED.description,status=EXCLUDED.status,current_version=EXCLUDED.current_version,version=EXCLUDED.version,updated_at=now()`,
        [definition.id,definition.tenantId,definition.code,definition.name,definition.description,definition.ownerId,definition.status,definition.currentVersion,definition.version],
      );
      await executor.query(
        `INSERT INTO process_definition_versions(id,tenant_id,definition_id,version,start_node_key,nodes,published_by,published_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [version.id,version.tenantId,version.definitionId,version.version,version.startNodeKey,version.nodes,version.publishedBy,version.publishedAt],
      );
    });
  }

  async getInstance(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM process_instances WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapInstance(rows[0]) : null;
    });
  }

  async saveInstance(instance: ProcessInstance, expectedVersion?: number): Promise<boolean> {
    return this.database.withTenant(instance.tenantId, async (executor) => {
      const params = [instance.id,instance.tenantId,instance.definitionId,instance.definitionVersion,instance.requesterId,instance.title,instance.formSnapshot,instance.status,instance.currentNodeKey,instance.riskLevel,instance.slaDueAt ?? null,instance.completedAt ?? null,instance.version];
      if (expectedVersion === undefined) {
        const rows = await executor.query(
          `INSERT INTO process_instances(id,tenant_id,definition_id,definition_version,requester_id,title,form_snapshot,status,current_node_key,risk_level,sla_due_at,completed_at,version)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING RETURNING id`, params,
        );
        return rows.length === 1;
      }
      const rows = await executor.query(
        `UPDATE process_instances SET title=$3,form_snapshot=$4,status=$5,current_node_key=$6,risk_level=$7,sla_due_at=$8,completed_at=$9,version=$10,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND version=$11 RETURNING id`,
        [instance.id,instance.tenantId,instance.title,instance.formSnapshot,instance.status,instance.currentNodeKey,instance.riskLevel,instance.slaDueAt ?? null,instance.completedAt ?? null,instance.version,expectedVersion],
      );
      return rows.length === 1;
    });
  }

  async listApprovals(tenantId: string, instanceId: string, nodeKey?: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query(
        `SELECT * FROM approvals WHERE tenant_id=$1 AND instance_id=$2 ${nodeKey ? "AND node_key=$3" : ""} ORDER BY created_at,id`,
        nodeKey ? [tenantId,instanceId,nodeKey] : [tenantId,instanceId],
      );
      return rows.map(mapApproval);
    });
  }

  async listOverdueApprovals(tenantId: string, dueBefore: string, limit: number) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query(
        `SELECT * FROM approvals
         WHERE tenant_id=$1 AND status='pending' AND escalated_from_id IS NULL AND due_at <= $2
         ORDER BY due_at,id LIMIT $3`,
        [tenantId,dueBefore,limit],
      );
      return rows.map(mapApproval);
    });
  }

  async getApproval(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM approvals WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapApproval(rows[0]) : null;
    });
  }

  async saveApprovals(approvals: Approval[]): Promise<void> {
    for (const approval of approvals) {
      await this.database.withTenant(approval.tenantId, (executor) => executor.query(
        `INSERT INTO approvals(id,tenant_id,instance_id,node_key,approver_id,requested_by,status,decision,comment,delegated_from_id,delegated_to_id,escalated_from_id,escalation_level,due_at,decided_at,version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(id) DO NOTHING`,
        [approval.id,approval.tenantId,approval.instanceId,approval.nodeKey,approval.approverId,approval.requestedBy,approval.status,approval.decision ?? null,approval.comment ?? null,approval.delegatedFromId ?? null,approval.delegatedToId ?? null,approval.escalatedFromId ?? null,approval.escalationLevel ?? null,approval.dueAt,approval.decidedAt ?? null,approval.version],
      ).then(() => undefined));
    }
  }

  async saveApproval(approval: Approval, expectedVersion: number): Promise<boolean> {
    return this.database.withTenant(approval.tenantId, async (executor) => {
      const rows = await executor.query(
        `UPDATE approvals SET status=$3,decision=$4,comment=$5,delegated_to_id=$6,escalated_from_id=$7,escalation_level=$8,decided_at=$9,version=$10,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND version=$11 RETURNING id`,
        [approval.tenantId,approval.id,approval.status,approval.decision ?? null,approval.comment ?? null,approval.delegatedToId ?? null,approval.escalatedFromId ?? null,approval.escalationLevel ?? null,approval.decidedAt ?? null,approval.version,expectedVersion],
      );
      return rows.length === 1;
    });
  }

  async getSnapshot(tenantId: string, actorId: string): Promise<WorkflowSnapshot> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [definitions, instances, approvals] = await Promise.all([
        executor.query("SELECT * FROM process_definitions WHERE tenant_id=$1 ORDER BY name", [tenantId]),
        executor.query("SELECT * FROM process_instances WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50", [tenantId]),
        executor.query("SELECT * FROM approvals WHERE tenant_id=$1 AND approver_id=$2 AND status='pending' ORDER BY due_at", [tenantId,actorId]),
      ]);
      return { definitions: definitions.map(mapDefinition), instances: instances.map(mapInstance), pendingApprovals: approvals.map(mapApproval), generatedAt: new Date().toISOString() };
    });
  }
}
