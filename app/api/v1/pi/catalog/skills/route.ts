import { NextResponse } from "next/server";
import { getPiProfile } from "@/src/modules/pi-agent/domain/profiles";
import { piProfileSchema } from "@/src/modules/pi-agent/application/schemas";
import { getPiResourceRegistry } from "@/src/modules/pi-agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const profile = piProfileSchema.parse(new URL(request.url).searchParams.get("profile") ?? "coding");
    const skills = await getPiResourceRegistry().listSkillCatalog(context, { profile, availableTools: getPiProfile(profile).allowedTools });
    return NextResponse.json({ data: skills, meta: { traceId: context.traceId, profile } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
