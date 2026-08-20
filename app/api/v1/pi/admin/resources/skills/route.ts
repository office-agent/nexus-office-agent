import { NextResponse } from "next/server";
import { getPiResourceRegistry } from "@/src/modules/pi-agent/runtime";
import { piSkillReleaseDraftSchema } from "@/src/modules/pi-agent/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson, requireIdempotencyKey } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    requireIdempotencyKey(request);
    const input = piSkillReleaseDraftSchema.parse(await parseJson(request));
    const release = await getPiResourceRegistry().publishSkillDraft(context, input);
    return NextResponse.json({ data: { id: release.id, skillId: release.skillId, version: release.version, digest: release.digest, approvalStatus: release.approvalStatus }, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
