export type SqlPrimitive = string | number | boolean | null | Date | Record<string, unknown> | unknown[];

export interface DatabaseExecutor {
  query<T extends Record<string, unknown>>(text: string, params?: SqlPrimitive[]): Promise<T[]>;
}

export interface TransactionalDatabase extends DatabaseExecutor {
  withTenant<T>(tenantId: string, work: (executor: DatabaseExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface MigrationDatabase extends DatabaseExecutor {
  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T>;
}
