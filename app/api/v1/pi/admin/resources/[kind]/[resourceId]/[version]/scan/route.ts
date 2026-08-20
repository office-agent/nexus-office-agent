import { NextResponse } from "next/server";
import { getPiResourceRegistry } from "@/src/modules/pi-agent/runtime";
import { piResourceScanSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ kind: string; resourceId: string; version: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const { kind, resourceId, version } = await params;
    if (!["package", "extension"].includes(kind)) throw new Error("PI_RESOURCE_SCAN_KIND_INVALID");
    const { status } = piResourceScanSchema.parse(await parseJson(request));
    const release = await getPiResourceRegistry().recordScanResult(context, { kind: kind as "package" | "extension", resourceId, version, status });
    return NextResponse.json({ data: { id: release.id, resourceId: release.resourceId, kind: release.kind, version: release.version, scanStatus: release.scanStatus }, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
