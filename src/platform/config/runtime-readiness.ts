import type { ReadinessCheck } from "@/src/platform/config/runtime-config";
import type { TransactionalDatabase } from "@/src/platform/database/executor";
import { probeOtlpExporter, type OtlpProbeResult } from "@/src/platform/observability/otlp-exporter";
import { PostgresWorkerHeartbeatRepository } from "@/src/platform/workers/postgres-work-repositories";
import type { WorkerRole } from "@/src/platform/workers/contracts";

function requiredRoles(value = process.env.REQUIRED_WORKER_ROLES ?? "inbox,agent,outbox"): WorkerRole[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter((item): item is WorkerRole => item === "inbox" || item === "agent" || item === "outbox" || item === "pi-runner" || item === "pi-change-delivery"))];
}

function requiredMigrations(roles: WorkerRole[]): string[] {
  if (roles.includes("pi-change-delivery")) return [
    "0023_work_artifact_evidence_chain",
    "0024_pi_enterprise_runtime",
    "0025_pi_run_control_plane",
    "0027_pi_workspace_git_artifact",
    "0030_pi_approval_gateway",
    "0040_pi_change_delivery",
    "0041_pi_change_delivery_worker",
    "0042_pi_change_delivery_leases",
  ];
  return roles.includes("pi-runner") ? ["0023_work_artifact_evidence_chain", "0025_pi_run_control_plane"] : ["0023_work_artifact_evidence_chain"];
}

function externalChangeDeliveryConfigured(env: NodeJS.ProcessEnv): boolean {
  if (env.NEXUS_PI_CHANGE_DELIVERY_EXTERNAL_ENABLED !== "true") return false;
  try { if (!env.NEXUS_PI_FORGEJO_API_URL || new URL(env.NEXUS_PI_FORGEJO_API_URL).protocol !== "https:") return false; } catch { return false; }
  if (env.SECRET_PROVIDER === "managed-http") {
    try { return Boolean(env.SECRET_MANAGER_AUTH_TOKEN && env.SECRET_MANAGER_URL && new URL(env.SECRET_MANAGER_URL).protocol === "https:"); } catch { return false; }
  }
  if (env.SECRET_PROVIDER === "openbao" || env.OPENBAO_ADDR) {
    try { return Boolean(env.OPENBAO_ADDR && new URL(env.OPENBAO_ADDR).protocol === "https:"); } catch { return false; }
  }
  return false;
}

export async function getRuntimeReadinessChecks(
  database: TransactionalDatabase,
  env: NodeJS.ProcessEnv = process.env,
  telemetryProbe: (environment: NodeJS.ProcessEnv) => Promise<OtlpProbeResult> = probeOtlpExporter,
  now = new Date(),
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  let databaseHealthy = false;
  try {
    await database.query("SELECT 1 AS healthy");
    databaseHealthy = true;
    checks.push({ id: "dependency.postgres", category: "data", status: "pass", message: "PostgreSQL 依赖探测通过。" });
  } catch {
    checks.push({ id: "dependency.postgres", category: "data", status: "fail", message: "PostgreSQL 依赖探测失败。" });
  }

  if (databaseHealthy) {
    const roles = requiredRoles(env.REQUIRED_WORKER_ROLES);
    const required = requiredMigrations(roles);
    const migrations = await database.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = ANY($1::text[])", [required]);
    const migrationReady = required.every((version) => migrations.some((row) => row.version === version));
    checks.push({ id: "runtime.migration", category: "data", status: migrationReady ? "pass" : "fail", message: migrationReady ? "平台及启用 Worker 所需数据库迁移已应用。" : `缺少必需迁移：${required.filter((version) => !migrations.some((row) => row.version === version)).join(",")}。` });
    if (migrationReady) {
      const maximumAgeMs = Number(env.WORKER_HEARTBEAT_MAX_AGE_MS ?? 45_000);
      const releaseVersion = env.NEXUS_RELEASE_VERSION ?? "0.14.0";
      const fresh = await new PostgresWorkerHeartbeatRepository(database).freshRoles({ roles, releaseVersion, now, maximumAgeMs });
      const missing = roles.filter((role) => !fresh.includes(role));
      checks.push({
        id: "runtime.workers",
        category: "operations",
        status: missing.length === 0 ? "pass" : "fail",
        message: missing.length === 0 ? `必需 Worker 心跳新鲜且版本为 ${releaseVersion}。` : `缺少新鲜同版本 Worker：${missing.join(", ")}。`,
      });
    } else {
      checks.push({ id: "runtime.workers", category: "operations", status: "fail", message: "迁移未就绪，无法验证 Worker 心跳。" });
    }
    if (roles.includes("pi-change-delivery")) checks.push({ id: "runtime.pi-change-delivery", category: "operations", status: externalChangeDeliveryConfigured(env) ? "pass" : "fail", message: externalChangeDeliveryConfigured(env) ? "Change Delivery 外部 Gateway 使用 HTTPS 和受管 Secret。" : "Change Delivery Worker 未配置 HTTPS Forgejo Gateway 或受管 Secret，保持失败关闭。" });
  } else {
    checks.push({ id: "runtime.migration", category: "data", status: "fail", message: "数据库不可用，无法验证迁移。" });
    checks.push({ id: "runtime.workers", category: "operations", status: "fail", message: "数据库不可用，无法验证 Worker 心跳。" });
  }

  const telemetry = await telemetryProbe(env);
  checks.push({
    id: "runtime.telemetry",
    category: "operations",
    status: telemetry.ok ? "pass" : "fail",
    message: telemetry.ok ? "OTLP 导出器真实发送探测通过。" : `OTLP 导出器探测失败：${telemetry.errorCode ?? "UNKNOWN"}。`,
  });
  return checks;
}
