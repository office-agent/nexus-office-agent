import { NextResponse } from "next/server";
import { getSafeRuntimeStatus } from "@/src/platform/config/runtime-config";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "nexus-office-agent",
    designBaseline: "design-v1.1-implementation",
    runtime: getSafeRuntimeStatus(),
    timestamp: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
