import { NextResponse } from "next/server";
import { getPiResourceRegistry } from "@/src/modules/pi-agent/runtime";
import { piResourceRolloutSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ kind: string; resourceId: string; version: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const { kind, resourceId, version } = await params;
    if (!["skill", "package", "extension"].includes(kind)) throw new Error("PI_RESOURCE_KIND_INVALID");
    const { percent } = piResourceRolloutSchema.parse(await parseJson(request));
    const release = await getPiResourceRegistry().rollout(context, { kind: kind as "skill" | "package" | "extension", resourceId, version, percent });
    return NextResponse.json({ data: { id: release.id, resourceId: "skillId" in release ? release.skillId : release.resourceId, kind, version: release.version, approvalStatus: release.approvalStatus, rolloutPercent: release.rolloutPercent }, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
