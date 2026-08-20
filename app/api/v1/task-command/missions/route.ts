import { NextResponse } from "next/server";
import { publishMissionSchema } from "@/src/modules/task-command/application/schemas";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = publishMissionSchema.parse(await parseJson(request));
    const result = await getTaskCommandService().publishMission(context, input, { source: "human" });
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } }, { status: result.created ? 201 : 200 });
  } catch (error) { return applicationErrorResponse(error); }
}
