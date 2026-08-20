import type { SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import type {
  PiSupervisorObject,
  PiSupervisorWorkspace,
  PiWorkspaceSupervisorPersistedGrant,
  PiWorkspaceSupervisorPersistedLease,
  PiWorkspaceSupervisorState,
} from "@/src/modules/pi-agent/workspace-supervisor/contracts";
import {
  emptyPiWorkspaceSupervisorState,
  validatePiWorkspaceSupervisorState,
  type PiWorkspaceSupervisorStateStore,
  type PiWorkspaceSupervisorStateStoreSaveOptions,
} from "@/src/modules/pi-agent/workspace-supervisor/state-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;

type Row = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function text(value: unknown, code: string, max = 256): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(code);
  return value;
}

function tenantId(value: unknown): string {
  const result = text(value, "PI_WORKSPACE_STATE_TENANT_INVALID", 64);
  if (!UUID.test(result)) throw new Error("PI_WORKSPACE_STATE_TENANT_INVALID");
  return result;
}

function asState(value: unknown): PiWorkspaceSupervisorState {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return validatePiWorkspaceSupervisorState(parsed);
}

function scopeTenant(value: { tenantId: string }): string {
  return tenantId(value.tenantId);
}

function stateForTenant(state: PiWorkspaceSupervisorState, targetTenantId: string): PiWorkspaceSupervisorState {
  const leases: PiWorkspaceSupervisorPersistedLease[] = state.leases.filter((item) => scopeTenant(item.scope) === targetTenantId).map((item) => clone(item));
  const workspaces: PiSupervisorWorkspace[] = state.workspaces.filter((item) => scopeTenant(item.context) === targetTenantId).map((item) => clone(item));
  const objects: PiSupervisorObject[] = state.objects.filter((item) => scopeTenant(item.scope) === targetTenantId).map((item) => clone(item));
  const grants: PiWorkspaceSupervisorPersistedGrant[] = state.grants.filter((item) => {
    const object = state.objects.find((candidate) => candidate.storageRef === item.storageRef);
    return object ? scopeTenant(object.scope) === targetTenantId : false;
  }).map((item) => clone(item));
  return validatePiWorkspaceSupervisorState({ schemaVersion: 1, leases, workspaces, objects, grants });
}

function mergeStates(states: PiWorkspaceSupervisorState[]): PiWorkspaceSupervisorState {
  return validatePiWorkspaceSupervisorState({
    schemaVersion: 1,
    leases: states.flatMap((state) => state.leases),
    workspaces: states.flatMap((state) => state.workspaces),
    objects: states.flatMap((state) => state.objects),
    grants: states.flatMap((state) => state.grants),
  });
}

function stateParam(state: PiWorkspaceSupervisorState): SqlPrimitive {
  return state as unknown as Record<string, unknown>;
}

/**
 * PostgreSQL-backed Supervisor state.
 *
 * State is partitioned by tenant and guarded by both forced RLS and a short
 * owner lease. A service instance must first claim every active tenant row;
 * another instance using the same stateId cannot silently become a
 * last-writer. Each mutation uses the version loaded by this instance as a
 * compare-and-swap token. The service passes the changed tenant so unrelated
 * tenant slices are never written from a stale in-memory snapshot.
 */
export class PostgresPiWorkspaceSupervisorStateStore implements PiWorkspaceSupervisorStateStore {
  private readonly stateId: string;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly versions = new Map<string, number>();
  private readonly ownedTenants = new Set<string>();

  constructor(
    private readonly database: TransactionalDatabase,
    options: { stateId: string; ownerId: string; leaseMs?: number },
  ) {
    this.stateId = text(options.stateId, "PI_WORKSPACE_STATE_ID_INVALID");
    this.ownerId = text(options.ownerId, "PI_WORKSPACE_STATE_OWNER_INVALID");
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) throw new Error("PI_WORKSPACE_STATE_LEASE_INVALID");
    this.leaseMs = leaseMs;
  }

  async load(): Promise<PiWorkspaceSupervisorState> {
    this.versions.clear();
    this.ownedTenants.clear();
    const tenants = await this.database.query<{ id: string }>(
      "SELECT id::text FROM tenants WHERE status IN ('provisioning','active','suspended') ORDER BY id",
    );
    const states: PiWorkspaceSupervisorState[] = [];
    for (const row of tenants) states.push(await this.claimTenant(tenantId(row.id)));
    return mergeStates(states.length > 0 ? states : [emptyPiWorkspaceSupervisorState()]);
  }

  async save(state: PiWorkspaceSupervisorState, options: PiWorkspaceSupervisorStateStoreSaveOptions = {}): Promise<void> {
    const validated = validatePiWorkspaceSupervisorState(state);
    const tenantIds = [...new Set(options.tenantIds?.map(tenantId) ?? [...this.ownedTenants])];
    for (const targetTenantId of tenantIds) {
      if (!this.ownedTenants.has(targetTenantId)) await this.claimTenant(targetTenantId);
      const expectedVersion = this.versions.get(targetTenantId);
      if (expectedVersion === undefined) throw new Error("PI_WORKSPACE_STATE_NOT_LOADED");
      const slice = stateForTenant(validated, targetTenantId);
      const rows = await this.database.withTenant(targetTenantId, async (db) => db.query<{ version: number | string }>(
        `UPDATE pi_workspace_supervisor_states
         SET state=$3::jsonb, schema_version=1, version=version+1, updated_at=now(), owner_expires_at=$4
         WHERE state_id=$1 AND tenant_id=$2 AND owner_id=$5 AND owner_expires_at>now() AND version=$6
         RETURNING version`,
        [this.stateId, targetTenantId, stateParam(slice), new Date(Date.now() + this.leaseMs), this.ownerId, expectedVersion],
      ));
      if (!rows[0]) throw new Error("PI_WORKSPACE_STATE_CONFLICT");
      this.versions.set(targetTenantId, Number(rows[0].version));
    }
  }

  async renew(): Promise<void> {
    for (const targetTenantId of this.ownedTenants) {
      const rows = await this.database.withTenant(targetTenantId, async (db) => db.query<{ tenant_id: string }>(
        `UPDATE pi_workspace_supervisor_states
         SET owner_expires_at=$3, updated_at=updated_at
         WHERE state_id=$1 AND tenant_id=$2 AND owner_id=$4 AND owner_expires_at>now()
         RETURNING tenant_id::text`,
        [this.stateId, targetTenantId, new Date(Date.now() + this.leaseMs), this.ownerId],
      ));
      if (!rows[0]) throw new Error("PI_WORKSPACE_STATE_OWNER_LOST");
    }
  }

  async release(): Promise<void> {
    for (const targetTenantId of this.ownedTenants) {
      await this.database.withTenant(targetTenantId, async (db) => {
        await db.query(
          `UPDATE pi_workspace_supervisor_states
           SET owner_id=NULL, owner_expires_at=NULL, updated_at=now()
           WHERE state_id=$1 AND tenant_id=$2 AND owner_id=$3`,
          [this.stateId, targetTenantId, this.ownerId],
        );
      });
    }
    this.ownedTenants.clear();
    this.versions.clear();
  }

  private async claimTenant(targetTenantId: string): Promise<PiWorkspaceSupervisorState> {
    const empty = emptyPiWorkspaceSupervisorState();
    const rows = await this.database.withTenant(targetTenantId, async (db) => db.query<Row>(
      `INSERT INTO pi_workspace_supervisor_states
         (state_id,tenant_id,schema_version,state,version,owner_id,owner_expires_at,updated_at)
       VALUES($1,$2,1,$3::jsonb,1,$4,$5,now())
       ON CONFLICT(state_id,tenant_id) DO UPDATE
         SET owner_id=EXCLUDED.owner_id, owner_expires_at=EXCLUDED.owner_expires_at, updated_at=now()
         WHERE pi_workspace_supervisor_states.owner_id IS NULL
            OR pi_workspace_supervisor_states.owner_id=EXCLUDED.owner_id
            OR pi_workspace_supervisor_states.owner_expires_at<=now()
       RETURNING state,version,owner_id`,
      [this.stateId, targetTenantId, stateParam(empty), this.ownerId, new Date(Date.now() + this.leaseMs)],
    ));
    if (!rows[0] || String(rows[0].owner_id) !== this.ownerId) throw new Error("PI_WORKSPACE_STATE_OWNER_CONFLICT");
    const state = asState(rows[0].state);
    this.versions.set(targetTenantId, Number(rows[0].version));
    this.ownedTenants.add(targetTenantId);
    return state;
  }
}
