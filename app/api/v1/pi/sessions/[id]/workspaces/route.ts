import { NextResponse } from "next/server";
import { getPiAgentService, getPiWorkspaceService } from "@/src/modules/pi-agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    await getPiAgentService().getSession(context, id);
    const workspaces = await getPiWorkspaceService().listWorkspaces(context, id);
    const safe = workspaces.map((workspace) => ({
      id: workspace.id,
      tenantId: workspace.tenantId,
      actorId: workspace.actorId,
      sessionId: workspace.sessionId,
      runId: workspace.runId,
      workspaceId: workspace.workspaceId,
      repositoryId: workspace.repositoryId,
      provider: workspace.provider,
      baseRef: workspace.baseRef,
      baseCommitSha: workspace.baseCommitSha,
      ephemeralBranch: workspace.ephemeralBranch,
      status: workspace.status,
      headCommitSha: workspace.headCommitSha,
      workspaceDigest: workspace.workspaceDigest,
      failureCode: workspace.failureCode,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      destroyedAt: workspace.destroyedAt,
    }));
    return NextResponse.json({ data: safe, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
