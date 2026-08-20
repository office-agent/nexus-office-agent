import type { WorkspaceBootstrapRepository } from "@/src/modules/workspace-bootstrap/application/contracts";
import type { TransactionalDatabase } from "@/src/platform/database/executor";

type IdentityRow = {
  tenant_id: string;
  tenant_name: string;
  actor_id: string;
  display_name: string;
};

type ProjectRow = {
  id: string;
  code: string;
  name: string;
  owner_id: string;
  status: string;
  priority: string;
  health: string;
  target_end_at: string | Date;
};

export class PostgresWorkspaceBootstrapRepository implements WorkspaceBootstrapRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getIdentity(tenantId: string, actorId: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<IdentityRow>(
        `SELECT t.id::text AS tenant_id,t.name AS tenant_name,u.id::text AS actor_id,u.display_name
         FROM tenants t JOIN users u ON u.tenant_id=t.id
         WHERE t.id=$1 AND u.id=$2 AND t.status='active' AND u.status='active'`,
        [tenantId, actorId],
      );
      const row = rows[0];
      return row ? {
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        actorId: row.actor_id,
        displayName: row.display_name,
      } : null;
    });
  }

  async listProjects(tenantId: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<ProjectRow>(
        `SELECT id::text,code,name,owner_id::text,status,priority,health,target_end_at
         FROM projects
         WHERE tenant_id=$1 AND archived_at IS NULL
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,updated_at DESC,id`,
        [tenantId],
      );
      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        ownerId: row.owner_id,
        status: row.status,
        priority: row.priority,
        health: row.health,
        targetEndAt: (row.target_end_at instanceof Date ? row.target_end_at.toISOString() : row.target_end_at).slice(0, 10),
      }));
    });
  }
}
