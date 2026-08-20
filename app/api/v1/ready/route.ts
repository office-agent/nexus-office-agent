import { NextResponse } from "next/server";
import { getProductionReadiness, getSafeRuntimeStatus } from "@/src/platform/config/runtime-config";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { getRuntimeReadinessChecks } from "@/src/platform/config/runtime-readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = getProductionReadiness();
  const checks = [...readiness.checks];
  if (readiness.ready && process.env.DATABASE_URL) {
    const database = createPostgresDatabase(process.env.DATABASE_URL);
    try {
      checks.push(...await getRuntimeReadinessChecks(database));
    } catch {
      checks.push({ id: "runtime.dependencies", category: "operations", status: "fail", message: "运行依赖探测未能完成。" });
    } finally {
      await database.close().catch(() => undefined);
    }
  }
  const ready = readiness.ready && checks.every((item) => item.status !== "fail");
  return NextResponse.json({ status: ready ? "ready" : "not_ready", mode: readiness.mode, checks, runtime: getSafeRuntimeStatus(), timestamp: new Date().toISOString() }, {
    status: ready ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
