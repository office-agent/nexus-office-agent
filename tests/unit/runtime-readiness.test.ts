// Requirements: AR-006, AR-009, AR-010, AC-006, AC-010, DR-009, DR-011
import { describe, expect, it, vi } from "vitest";
import { getRuntimeReadinessChecks } from "@/src/platform/config/runtime-readiness";
import { probeOtlpExporter } from "@/src/platform/observability/otlp-exporter";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";

function databaseFixture(input: { migration?: boolean; migrations?: string[]; roles?: string[]; available?: boolean }): TransactionalDatabase {
  const executor: DatabaseExecutor = {
    async query<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
      if (input.available === false) throw new Error("DATABASE_UNAVAILABLE");
      if (sql.includes("schema_migrations")) return (input.migration === false ? [] : (input.migrations ?? ["0023_work_artifact_evidence_chain", "0025_pi_run_control_plane"]).map((version) => ({ version }))) as unknown as T[];
      if (sql.includes("worker_heartbeats")) return (input.roles ?? ["inbox","agent","outbox"]).map((role) => ({ role })) as unknown as T[];
      return [{ healthy: 1 }] as unknown as T[];
    },
  };
  return { ...executor, async withTenant<T>(_tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { return work(executor); }, async close() {} };
}

describe("runtime readiness evidence", () => {
  it("passes only with the durable migration, fresh same-version workers and a real telemetry receipt", async () => {
    const checks = await getRuntimeReadinessChecks(
      databaseFixture({}),
      { NODE_ENV: "production", NEXUS_RELEASE_VERSION: "0.14.0", REQUIRED_WORKER_ROLES: "inbox,agent,outbox" },
      async () => ({ ok: true }),
      new Date("2026-08-05T00:00:00.000Z"),
    );
    expect(checks.every(({ status }) => status === "pass")).toBe(true);
  });

  it("fails when a required worker is absent even if configuration strings exist", async () => {
    const checks = await getRuntimeReadinessChecks(
      databaseFixture({ roles: ["inbox","outbox"] }),
      { NODE_ENV: "production", NEXUS_RELEASE_VERSION: "0.14.0", REQUIRED_WORKER_ROLES: "inbox,agent,outbox" },
      async () => ({ ok: true }),
    );
    expect(checks.find(({ id }) => id === "runtime.workers")).toMatchObject({ status: "fail" });
    expect(checks.find(({ id }) => id === "runtime.workers")?.message).toContain("agent");
  });

  it("sends a minimal OTLP payload and reports only safe error categories", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    expect(await probeOtlpExporter({ NODE_ENV: "production", OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example/collector", NEXUS_RELEASE_VERSION: "0.14.0" }, fetcher)).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toBe("https://otel.example/collector/v1/logs");
    expect(await probeOtlpExporter({ NODE_ENV: "production", OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url" }, fetcher)).toEqual({ ok: false, errorCode: "OTLP_CONFIGURATION_INVALID" });
  });

  it("requires the Pi Run migration and a fresh pi-runner heartbeat when that role is enabled", async () => {
    const checks = await getRuntimeReadinessChecks(
      databaseFixture({ roles: ["inbox", "agent", "outbox", "pi-runner"] }),
      { NODE_ENV: "production", NEXUS_RELEASE_VERSION: "0.15.0-pi-runner-spike", REQUIRED_WORKER_ROLES: "inbox,agent,outbox,pi-runner" },
      async () => ({ ok: true }),
    );
    expect(checks.find(({ id }) => id === "runtime.migration")).toMatchObject({ status: "pass" });
    expect(checks.find(({ id }) => id === "runtime.workers")).toMatchObject({ status: "pass" });
  });

  it("requires the complete Change Delivery schema and worker heartbeat role when enabled", async () => {
    const migrations = [
      "0023_work_artifact_evidence_chain", "0024_pi_enterprise_runtime", "0025_pi_run_control_plane",
      "0027_pi_workspace_git_artifact", "0030_pi_approval_gateway", "0040_pi_change_delivery", "0041_pi_change_delivery_worker", "0042_pi_change_delivery_leases",
    ];
    const checks = await getRuntimeReadinessChecks(
      databaseFixture({ migrations, roles: ["inbox", "agent", "outbox", "pi-change-delivery"] }),
      { NODE_ENV: "production", NEXUS_RELEASE_VERSION: "0.16.0", REQUIRED_WORKER_ROLES: "inbox,agent,outbox,pi-change-delivery", NEXUS_PI_CHANGE_DELIVERY_EXTERNAL_ENABLED: "true", NEXUS_PI_FORGEJO_API_URL: "https://forgejo.example/api/v1", SECRET_PROVIDER: "openbao", OPENBAO_ADDR: "https://openbao.example" },
      async () => ({ ok: true }),
    );
    expect(checks.find(({ id }) => id === "runtime.migration")).toMatchObject({ status: "pass" });
    expect(checks.find(({ id }) => id === "runtime.workers")).toMatchObject({ status: "pass" });
    expect(checks.find(({ id }) => id === "runtime.pi-change-delivery")).toMatchObject({ status: "pass" });
  });
});
