import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPiWorkspaceSupervisorServer } from "../src/modules/pi-agent/workspace-supervisor/http-server";
import { PiWorkspaceSupervisorService } from "../src/modules/pi-agent/workspace-supervisor/service";
import type { PiWorkspaceSupervisorConfig } from "../src/modules/pi-agent/workspace-supervisor/contracts";
import { PostgresPiWorkspaceSupervisorStateStore } from "../src/modules/pi-agent/workspace-supervisor/postgres-state-store";
import { createPostgresDatabase } from "../src/platform/database/postgres";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function main(): Promise<void> {
  const database = process.env.DATABASE_URL ? createPostgresDatabase(process.env.DATABASE_URL) : undefined;
  const stateFile = process.env.NEXUS_PI_WORKSPACE_STATE_FILE;
  if (!database && !stateFile?.trim()) throw new Error("PI_WORKSPACE_STATE_STORE_REQUIRED");
  const config: PiWorkspaceSupervisorConfig = {
    rootDirectory: process.env.NEXUS_PI_WORKSPACE_ROOT ?? "/var/lib/nexus/pi-workspaces",
    forgejoBaseUrl: required("NEXUS_PI_FORGEJO_BASE_URL"),
    forgejoUsername: required("NEXUS_PI_FORGEJO_USERNAME"),
    forgejoToken: required("NEXUS_PI_FORGEJO_TOKEN"),
    s3Endpoint: required("NEXUS_PI_S3_ENDPOINT"),
    s3AccessKey: required("NEXUS_PI_S3_ACCESS_KEY"),
    s3SecretKey: required("NEXUS_PI_S3_SECRET_KEY"),
    s3Bucket: process.env.NEXUS_PI_S3_BUCKET ?? "pi-artifacts",
    s3Region: process.env.NEXUS_PI_S3_REGION ?? "us-east-1",
    publicBaseUrl: required("NEXUS_PI_WORKSPACE_PUBLIC_URL"),
    ...(stateFile ? { stateFile } : {}),
    maxBodyBytes: Number(process.env.NEXUS_PI_WORKSPACE_MAX_BODY_BYTES ?? 24 * 1024 * 1024),
  };
  const tlsKeyPath = process.env.NEXUS_PI_WORKSPACE_TLS_KEY;
  const tlsCertPath = process.env.NEXUS_PI_WORKSPACE_TLS_CERT;
  const allowHttp = process.env.NODE_ENV !== "production" && process.env.NEXUS_PI_WORKSPACE_ALLOW_HTTP === "1";
  if ((!tlsKeyPath || !tlsCertPath) && !allowHttp) throw new Error("PI_WORKSPACE_TLS_REQUIRED");
  const tls = tlsKeyPath && tlsCertPath ? { key: await readFile(tlsKeyPath), cert: await readFile(tlsCertPath) } : undefined;
  const stateStore = database
    ? new PostgresPiWorkspaceSupervisorStateStore(database, {
      stateId: required("NEXUS_PI_WORKSPACE_STATE_ID"),
      ownerId: process.env.NEXUS_PI_WORKSPACE_INSTANCE_ID ?? `pi-workspace-${process.pid}-${randomUUID()}`,
      leaseMs: Number(process.env.NEXUS_PI_WORKSPACE_STATE_LEASE_MS ?? 5 * 60 * 1_000),
    })
    : undefined;
  const service = new PiWorkspaceSupervisorService(config, stateStore);
  await service.ready();
  const host = process.env.NEXUS_PI_WORKSPACE_HOST ?? "0.0.0.0";
  const port = Number(process.env.NEXUS_PI_WORKSPACE_PORT ?? "8443");
  const server = createPiWorkspaceSupervisorServer({ service, maxBodyBytes: config.maxBodyBytes, tls });
  server.listen(port, host, () => process.stdout.write(`${JSON.stringify({ status: "listening", host, port, tls: Boolean(tls), provider: "forgejo", objectStorage: "s3" })}\n`));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await service.close().catch(() => undefined);
      await database?.close().catch(() => undefined);
      server.close(() => process.exit(0));
    })();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "not_ready", code: error instanceof Error ? error.message : "PI_WORKSPACE_SUPERVISOR_NOT_READY" })}\n`);
  process.exitCode = 1;
});
