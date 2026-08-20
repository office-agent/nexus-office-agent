import type { DataScope } from "@/src/platform/context/request-context";
import type { TransactionalDatabase } from "@/src/platform/database/executor";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

export type AuthorizationSnapshot = {
  roles: string[];
  permissions: string[];
  dataScopes: DataScope[];
};

export interface AuthorizationResolver {
  resolve(tenantId: string, actorId: string, now?: Date): Promise<AuthorizationSnapshot | null>;
}

export class AuthorizationSourceUnavailableError extends Error {
  constructor() {
    super("AUTHORIZATION_SOURCE_UNAVAILABLE");
    this.name = "AuthorizationSourceUnavailableError";
  }
}

type RoleRow = {
  role_code: string;
  scope_type: DataScope["type"];
  scope_value: unknown;
};

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return asObject(JSON.parse(value)); } catch { throw new Error("AUTHORIZATION_SCOPE_INVALID"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AUTHORIZATION_SCOPE_INVALID");
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, field: string): string[] {
  const object = asObject(value);
  const items = object[field];
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string" || !item)) throw new Error("AUTHORIZATION_SCOPE_INVALID");
  return [...new Set(items)];
}

export function mapStoredDataScope(type: DataScope["type"], value: unknown): DataScope {
  switch (type) {
    case "self": return { type };
    case "owned": return { type };
    case "tenant": return { type };
    case "team": return { type, teamIds: stringArray(value, "teamIds") };
    case "org_subtree": return { type, orgUnitIds: stringArray(value, "orgUnitIds") };
    case "project": return { type, projectIds: stringArray(value, "projectIds") };
    case "explicit": return { type, resourceIds: stringArray(value, "resourceIds") };
    default: throw new Error("AUTHORIZATION_SCOPE_INVALID");
  }
}

export class PostgresAuthorizationResolver implements AuthorizationResolver {
  constructor(private readonly database: TransactionalDatabase) {}

  async resolve(tenantId: string, actorId: string, now = new Date()): Promise<AuthorizationSnapshot | null> {
    try {
      return await this.database.withTenant(tenantId, async (executor) => {
        const users = await executor.query<{ status: string }>(
          "SELECT status FROM users WHERE tenant_id=$1 AND id=$2",
          [tenantId, actorId],
        );
        if (users[0]?.status !== "active") return null;

        const roleRows = await executor.query<RoleRow>(
          `SELECT r.code AS role_code,ur.scope_type,ur.scope_value
             FROM user_roles ur JOIN roles r ON r.tenant_id=ur.tenant_id AND r.id=ur.role_id
            WHERE ur.tenant_id=$1 AND ur.user_id=$2 AND ur.starts_at<=$3
              AND (ur.expires_at IS NULL OR ur.expires_at>$3)
            ORDER BY r.code,ur.id`,
          [tenantId, actorId, now],
        );
        const permissions = await executor.query<{ permission_code: string }>(
          `SELECT DISTINCT p.code AS permission_code
             FROM user_roles ur
             JOIN role_permissions rp ON rp.tenant_id=ur.tenant_id AND rp.role_id=ur.role_id
             JOIN permissions p ON p.id=rp.permission_id
            WHERE ur.tenant_id=$1 AND ur.user_id=$2 AND ur.starts_at<=$3
              AND (ur.expires_at IS NULL OR ur.expires_at>$3)
            ORDER BY p.code`,
          [tenantId, actorId, now],
        );
        return {
          roles: [...new Set(roleRows.map((row) => row.role_code))],
          permissions: permissions.map((row) => row.permission_code),
          dataScopes: roleRows.map((row) => mapStoredDataScope(row.scope_type, row.scope_value)),
        };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "AUTHORIZATION_SCOPE_INVALID") throw error;
      throw new AuthorizationSourceUnavailableError();
    }
  }
}

const runtime = globalThis as typeof globalThis & {
  __nexusAuthorizationResolver?: AuthorizationResolver;
  __nexusAuthorizationResolverUrl?: string;
};

export function getProductionAuthorizationResolver(): AuthorizationResolver {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new AuthorizationSourceUnavailableError();
  if (!runtime.__nexusAuthorizationResolver || runtime.__nexusAuthorizationResolverUrl !== databaseUrl) {
    runtime.__nexusAuthorizationResolver = new PostgresAuthorizationResolver(createPostgresDatabase(databaseUrl));
    runtime.__nexusAuthorizationResolverUrl = databaseUrl;
  }
  return runtime.__nexusAuthorizationResolver;
}
