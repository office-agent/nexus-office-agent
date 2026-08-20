import { createHash } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiRunManifest, PiSession } from "@/src/modules/pi-agent/domain/contracts";
import { getPiProfile } from "@/src/modules/pi-agent/domain/profiles";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function profileDigest(profileId: PiSession["profile"]): string {
  const profile = getPiProfile(profileId);
  return sha256(stableJson({
    id: profile.id,
    version: profile.version,
    allowedTools: [...profile.allowedTools].sort(),
    requiredPermissions: [...profile.requiredPermissions].sort(),
    maxRiskLevel: profile.maxRiskLevel,
    networkPolicy: profile.networkPolicy,
    canModifyWorkspace: profile.canModifyWorkspace,
    canExecuteSandbox: profile.canExecuteSandbox,
  }));
}

function providerFromSandboxProfile(value: string): "virtual" | "firecracker" | "kata" | "unavailable" {
  const provider = value.split(":", 1)[0];
  return provider === "virtual" || provider === "firecracker" || provider === "kata" ? provider : "unavailable";
}

export function buildPiRunManifest(
  context: RequestContext,
  session: PiSession,
  message: string,
  runId: string,
  now = new Date(),
): PiRunManifest {
  const profile = getPiProfile(session.profile);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const unsigned = {
    schemaVersion: 1 as const,
    tenantId: context.tenantId,
    actorId: context.actorId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    sessionVersion: session.lastEventSequence,
    runId,
    traceId: context.traceId,
    ...(session.repositoryId ? { repository: { repositoryId: session.repositoryId, baseRef: session.baseRef, baseCommit: session.baseCommit } } : {}),
    profile: { id: profile.id, version: profile.version, digest: profileDigest(profile.id) },
    resourceSnapshot: {
      schemaVersion: session.resourceSnapshot?.schemaVersion ?? 0,
      registryVersion: session.resourceSnapshot?.registryVersion ?? "legacy",
      ...(session.resourceSnapshot?.resolvedAt ? { resolvedAt: session.resourceSnapshot.resolvedAt } : {}),
      skillDigests: [...(session.resourceSnapshot?.skillDigests ?? session.skillDigests)].sort(),
      extensionDigests: [...(session.resourceSnapshot?.extensionDigests ?? [])].sort(),
      packageDigests: [...(session.resourceSnapshot?.packageDigests ?? [])].sort(),
      mcpServerDigests: [...session.mcpServerDigests].sort(),
    },
    toolSnapshot: { names: [...profile.allowedTools, ...session.mcpBindings.map((binding) => binding.exposedName)].sort(), policyVersion: session.policyVersion },
    mcpBindings: session.mcpBindings.map((binding) => ({ ...binding })).sort((left, right) => left.bindingId.localeCompare(right.bindingId)),
    modelPolicy: { id: session.modelPolicy, version: 1, dataClassification: "internal" as const },
    sandbox: { profile: session.sandboxProfile, provider: providerFromSandboxProfile(session.sandboxProfile), networkPolicy: session.networkPolicy },
    quota: { maxDurationMs: 10 * 60 * 1000, maxOutputBytes: 1_000_000 },
    policyVersion: session.policyVersion,
    promptDigest: sha256(message),
    createdAt,
    expiresAt,
  };
  const manifestDigest = sha256(stableJson(unsigned));
  return {
    ...unsigned,
    manifestDigest,
    controllerSignature: `dev-controller:${manifestDigest}`,
  };
}

export function verifyPiRunManifest(manifest: PiRunManifest): boolean {
  const { manifestDigest, controllerSignature, ...unsigned } = manifest;
  return manifestDigest === sha256(stableJson(unsigned)) && controllerSignature === `dev-controller:${manifestDigest}`;
}
