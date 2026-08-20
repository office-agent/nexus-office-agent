import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiSandbox } from "@/src/modules/pi-agent/domain/contracts";
import type { PiResolvedResourceSet } from "@/src/modules/pi-agent/domain/resource-contracts";

/**
 * A resource materializer is the only boundary allowed to turn an approved
 * registry artifact into executable Pi resources. The production implementation
 * is expected to fetch a digest-pinned OCI artifact inside the sandbox worker,
 * verify its content and return only the capabilities declared below.
 *
 * The interface deliberately does not expose registry credentials or an
 * arbitrary filesystem path to Pi. The current worker has no default
 * materializer; without an explicitly configured implementation, executable
 * Package/Extension resources remain unavailable.
 */
export type PiMaterializedArtifact = {
  kind: "package" | "extension";
  digest: string;
  extensionFactories: InlineExtension[];
};

export type PiMaterializedResourceSet = {
  artifacts: PiMaterializedArtifact[];
};

export type PiResourceMaterializerInput = {
  context: RequestContext;
  sandbox: PiSandbox;
  resources: PiResolvedResourceSet;
  signal?: AbortSignal;
};

export interface PiResourceMaterializer {
  materialize(input: PiResourceMaterializerInput): Promise<PiMaterializedResourceSet>;
  dispose?(input: PiResourceMaterializerInput & { materialized: PiMaterializedResourceSet }): Promise<void>;
}

function expectedArtifactKeys(resources: PiResolvedResourceSet): Set<string> {
  return new Set([
    ...resources.packages.map((artifact) => `package:${artifact.digest}`),
    ...resources.extensions.map((artifact) => `extension:${artifact.digest}`),
  ]);
}

/**
 * Verify the materializer output against the already revalidated registry
 * snapshot. This prevents a materializer from silently dropping an artifact,
 * injecting an artifact that was not in the snapshot, or returning a no-op
 * Extension entry that would make the resource appear loaded when it was not.
 */
export function assertPiMaterializationMatchesSnapshot(
  resources: PiResolvedResourceSet,
  materialized: PiMaterializedResourceSet,
): void {
  const expected = expectedArtifactKeys(resources);
  const actual = new Set<string>();

  for (const artifact of materialized.artifacts) {
    const key = `${artifact.kind}:${artifact.digest}`;
    if (!expected.has(key)) throw new Error("PI_RESOURCE_MATERIALIZATION_EXTRA");
    if (actual.has(key)) throw new Error("PI_RESOURCE_MATERIALIZATION_DUPLICATE");
    actual.add(key);
    if (!Array.isArray(artifact.extensionFactories) || artifact.extensionFactories.length === 0) {
      throw new Error("PI_RESOURCE_ARTIFACT_EMPTY");
    }
  }

  if (actual.size !== expected.size) throw new Error("PI_RESOURCE_MATERIALIZATION_MISSING");
}

export function hasPiRuntimeArtifacts(resources: PiResolvedResourceSet): boolean {
  return resources.packages.length > 0 || resources.extensions.length > 0;
}
