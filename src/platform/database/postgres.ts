import postgres, { type Sql } from "postgres";
import type { DatabaseExecutor, MigrationDatabase, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { activeRequestContext } from "@/src/platform/context/request-context-storage";

function createExecutor(sql: Pick<Sql, "unsafe">): DatabaseExecutor {
  return {
    async query<T extends Record<string, unknown>>(text: string, params: SqlPrimitive[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
  };
}

export function createPostgresDatabase(databaseUrl: string): TransactionalDatabase & MigrationDatabase {
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => undefined,
  });
  const base = createExecutor(sql);
  return {
    query: base.query,
    async transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
      return sql.begin((transaction) => work(createExecutor(transaction))) as Promise<T>;
    },
    async withTenant<T>(tenantId: string, work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
      return sql.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${tenantId}, true)`;
        const context=activeRequestContext();
        if(context?.tenantId===tenantId){
          await transaction`select set_config('app.actor_id', ${context.actorId}, true)`;
          await transaction`select set_config('app.actor_type', ${context.channel==="system"?"system":"user"}, true)`;
          await transaction`select set_config('app.channel', ${context.channel}, true)`;
          await transaction`select set_config('app.trace_id', ${context.traceId}, true)`;
        }
        return work(createExecutor(transaction));
      }) as Promise<T>;
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
