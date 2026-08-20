import type { RequestContext } from "@/src/platform/context/request-context";
import { getPiProfile } from "@/src/modules/pi-agent/domain/profiles";
import type { PiProfileId, PiSessionCreateInput } from "@/src/modules/pi-agent/domain/contracts";

export function assertPiPermission(context: RequestContext, permission: string): void {
  if (context.channel === "system" || context.permissions.includes(permission)) return;
  throw new Error(`POLICY_DENIED:${permission}`);
}

export function assertPiProfileAccess(context: RequestContext, input: PiSessionCreateInput): void {
  const profile = getPiProfile(input.profile);
  for (const permission of profile.requiredPermissions) assertPiPermission(context, permission);
  if (!input.workspaceId || input.workspaceId.length > 256) throw new Error("PI_WORKSPACE_INVALID");
  if (input.repositoryId && input.repositoryId.length > 256) throw new Error("PI_REPOSITORY_INVALID");
  if (input.baseRef && (input.baseRef.length > 256 || !/^[A-Za-z0-9._/-]+$/.test(input.baseRef))) throw new Error("PI_BASE_REF_INVALID");
  if (input.baseCommit && !/^[a-f0-9]{7,64}$/i.test(input.baseCommit)) throw new Error("PI_BASE_COMMIT_INVALID");
}

export function assertPiToolAllowed(profile: PiProfileId, toolName: string, context: RequestContext): void {
  const profileConfig = getPiProfile(profile);
  if (!profileConfig.allowedTools.includes(toolName)) throw new Error("PI_TOOL_NOT_ALLOWED");
  if (toolName === "workspace_write" || toolName === "workspace_apply_patch") assertPiPermission(context, "pi:workspace:write");
  if (toolName === "workspace_run") assertPiPermission(context, "pi:sandbox:execute");
}
