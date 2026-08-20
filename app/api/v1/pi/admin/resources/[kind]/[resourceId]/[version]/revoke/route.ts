import { NextResponse } from "next/server";
import { getPiResourceRegistry } from "@/src/modules/pi-agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ kind: string; resourceId: string; version: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const { kind, resourceId, version } = await params;
    if (!["skill", "package", "extension"].includes(kind)) throw new Error("PI_RESOURCE_KIND_INVALID");
    const release = await getPiResourceRegistry().revoke(context, { kind: kind as "skill" | "package" | "extension", resourceId, version });
    return NextResponse.json({ data: { id: release.id, resourceId: "skillId" in release ? release.skillId : release.resourceId, kind, version: release.version, approvalStatus: release.approvalStatus, rolloutPercent: release.rolloutPercent }, meta: { traceId: context.traceId } }, { status: 202 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
