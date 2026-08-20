// Requirements: PR-010, SR-005, SR-006, AC-011, AC-012, DR-010
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, ExtensionAPI, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAgentSession, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiSandbox, PiSession } from "@/src/modules/pi-agent/domain/contracts";
import type { PiResolvedResourceSet } from "@/src/modules/pi-agent/domain/resource-contracts";
import { createPiRuntime } from "@/src/modules/pi-agent/infrastructure/runtime-adapter";
import type { PiMaterializedResourceSet, PiResourceMaterializer } from "@/src/modules/pi-agent/infrastructure/resource-materializer";

const TENANT_ID = "50000000-0000-4000-8000-000000000001";
const ACTOR_ID = "50000000-0000-4000-8000-000000000002";
const EXTENSION_DIGEST = createHash("sha256").update("approved-extension-v1").digest("hex");

const context: RequestContext = {
  tenantId: TENANT_ID,
  actorId: ACTOR_ID,
  sessionId: "resource-materializer-session",
  channel: "system",
  traceId: "resource-materializer-trace",
  roles: ["pi-runner"],
  permissions: [],
  dataScopes: [{ type: "tenant" }],
};

const sandbox: PiSandbox = {
  id: "sandbox-resource-materializer",
  root: "C:\\nexus-pi-sandbox\\run-1",
  provider: "firecracker",
  executionBoundary: "guest",
  tenantId: TENANT_ID,
  actorId: ACTOR_ID,
  sessionId: context.sessionId,
  workspaceId: "workspace-resource-materializer",
  runId: "run-resource-materializer",
};

const sessionRecord: PiSession = {
  id: context.sessionId,
  tenantId: TENANT_ID,
  actorId: ACTOR_ID,
  workspaceId: "workspace-resource-materializer",
  profile: "coding",
  profileVersion: 1,
  status: "running",
  modelPolicy: "private-default",
  sandboxProfile: "firecracker-default",
  networkPolicy: "none",
  policyVersion: 7,
  skillDigests: [],
  mcpServerDigests: [],
  mcpBindingIds: [],
  mcpBindings: [],
  resourceSnapshot: {
    schemaVersion: 1,
    skillDigests: [],
    packageDigests: [],
    extensionDigests: [EXTENSION_DIGEST],
    policyVersion: 7,
    registryVersion: "registry-test-v1",
    resolvedAt: new Date().toISOString(),
  },
  sandboxRunId: "sandbox-run-resource-materializer",
  traceId: context.traceId,
  lastEventSequence: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function resources(): PiResolvedResourceSet {
  return {
    snapshot: sessionRecord.resourceSnapshot!,
    skills: [],
    packages: [],
    extensions: [{
      id: "50000000-0000-4000-8000-000000000010",
      tenantId: TENANT_ID,
      resourceId: "policy-extension",
      kind: "extension",
      version: "1.0.0",
      digest: EXTENSION_DIGEST,
      signature: "signature-verified-before-runtime",
      artifactRef: `oci://registry.internal/pi/policy-extension@sha256:${EXTENSION_DIGEST}`,
      sbomDigest: createHash("sha256").update("policy-extension-sbom-v1").digest("hex"),
      scanStatus: "passed",
      approvalStatus: "approved",
      rolloutPercent: 100,
      allowedProfiles: ["coding"],
      dataClassification: "internal",
      riskLevel: "R2",
      createdAt: new Date().toISOString(),
    }],
  };
}

describe("Pi resource materializer runtime binding", () => {
  it("installs the server-owned policy extension even when no registry resource snapshot is present", async () => {
    vi.stubEnv("NEXUS_PI_MODEL_MODE", "disabled");
    let captured: CreateAgentSessionOptions | undefined;
    const fakeSession = {
      abort: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as AgentSession;
    const createAgentSessionFn = vi.fn(async (options?: CreateAgentSessionOptions) => {
      captured = options;
      return { session: fakeSession, extensionsResult: undefined as never };
    }) as unknown as typeof createAgentSession;
    try {
      const runtime = await createPiRuntime({
        context,
        record: sessionRecord,
        sandbox,
        provider: {} as never,
        history: [],
        enforceEnterprisePolicy: true,
        createAgentSessionFn,
      });
      const loader = captured?.resourceLoader as ResourceLoader;
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().extensions.map((extension) => extension.path)).toContain("<inline:enterprise-policy>");
      expect(loader.getSkills().skills).toEqual([]);
      await runtime.dispose();
      expect(fakeSession.abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("loads only snapshot-matching materialized extensions into the real Pi ResourceLoader", async () => {
    vi.stubEnv("NEXUS_PI_MODEL_MODE", "disabled");
    const extensionFactory = (pi: ExtensionAPI) => {
      pi.on("session_start", () => undefined);
    };
    const materializer: PiResourceMaterializer = {
      materialize: vi.fn(async (): Promise<PiMaterializedResourceSet> => ({
        artifacts: [{ kind: "extension", digest: EXTENSION_DIGEST, extensionFactories: [{ name: "ignored-by-loader", factory: extensionFactory }] }],
      })),
      dispose: vi.fn(async () => undefined),
    };
    let captured: CreateAgentSessionOptions | undefined;
    const fakeSession = {
      abort: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as AgentSession;
    const createAgentSessionFn = vi.fn(async (options?: CreateAgentSessionOptions) => {
      captured = options;
      return { session: fakeSession, extensionsResult: undefined as never };
    }) as unknown as typeof createAgentSession;

    try {
      const runtime = await createPiRuntime({
        context,
        record: sessionRecord,
        sandbox,
        provider: {} as never,
        history: [],
        resources: resources(),
        resourceMaterializer: materializer,
        createAgentSessionFn,
      });

      expect(materializer.materialize).toHaveBeenCalledTimes(1);
      expect(captured).toBeDefined();
      const loader = captured?.resourceLoader as ResourceLoader;
      expect(loader).toBeDefined();
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().extensions).toHaveLength(1);
      expect(loader.getExtensions().extensions[0]?.path).toBe("<inline:registry-extension-" + EXTENSION_DIGEST.slice(0, 16) + "-1>");
      expect(loader.getSkills().skills).toEqual([]);
      expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
      expect((loader as unknown as { cwd: string }).cwd).toBe(sandbox.root);

      await runtime.dispose();
      expect(materializer.dispose).toHaveBeenCalledTimes(1);
      expect(fakeSession.abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses executable resources without a real micro-VM even when a materializer is present", async () => {
    vi.stubEnv("NEXUS_PI_MODEL_MODE", "disabled");
    const materializer: PiResourceMaterializer = {
      materialize: vi.fn(async (): Promise<PiMaterializedResourceSet> => ({ artifacts: [{ kind: "extension", digest: EXTENSION_DIGEST, extensionFactories: [() => undefined] }] })),
    };
    try {
      await expect(createPiRuntime({
        context,
        record: sessionRecord,
        sandbox: { ...sandbox, provider: "virtual" },
        provider: {} as never,
        history: [],
        resources: resources(),
        resourceMaterializer: materializer,
      })).rejects.toThrow("PI_RESOURCE_RUNTIME_SANDBOX_REQUIRED");
      expect(materializer.materialize).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a provider-labelled sandbox without an explicit Guest execution boundary", async () => {
    vi.stubEnv("NEXUS_PI_MODEL_MODE", "disabled");
    const materializer: PiResourceMaterializer = {
      materialize: vi.fn(async (): Promise<PiMaterializedResourceSet> => ({ artifacts: [{ kind: "extension", digest: EXTENSION_DIGEST, extensionFactories: [() => undefined] }] })),
    };
    try {
      await expect(createPiRuntime({
        context,
        record: sessionRecord,
        sandbox: { ...sandbox, executionBoundary: "host" },
        provider: {} as never,
        history: [],
        resources: resources(),
        resourceMaterializer: materializer,
      })).rejects.toThrow("PI_RESOURCE_RUNTIME_GUEST_BOUNDARY_REQUIRED");
      expect(materializer.materialize).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects missing, extra and empty materialization before Pi startup", async () => {
    vi.stubEnv("NEXUS_PI_MODEL_MODE", "disabled");
    const variants: Array<[string, PiResourceMaterializer]> = [
      ["missing", { materialize: vi.fn(async (): Promise<PiMaterializedResourceSet> => ({ artifacts: [] })) }],
      ["extra", { materialize: vi.fn(async (): Promise<PiMaterializedResourceSet> => ({ artifacts: [{ kind: "extension", digest: "a".repeat(64), extensionFactories: [() => undefined] }] })) }],
      ["empty", { materialize: vi.fn(async (): Promise<PiMaterializedResourceSet> => ({ artifacts: [{ kind: "extension", digest: EXTENSION_DIGEST, extensionFactories: [] }] })) }],
    ];
    try {
      for (const [name, materializer] of variants) {
        await expect(createPiRuntime({
          context,
          record: sessionRecord,
          sandbox,
          provider: {} as never,
          history: [],
          resources: resources(),
          resourceMaterializer: materializer,
        })).rejects.toThrow(name === "missing" ? "PI_RESOURCE_MATERIALIZATION_MISSING" : name === "extra" ? "PI_RESOURCE_MATERIALIZATION_EXTRA" : "PI_RESOURCE_ARTIFACT_EMPTY");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("cleans materialized resources when the Pi SDK fails during startup", async () => {
    vi.stubEnv("NEXUS_PI_MODEL_MODE", "disabled");
    const materializer: PiResourceMaterializer = {
      materialize: vi.fn(async (): Promise<PiMaterializedResourceSet> => ({ artifacts: [{ kind: "extension", digest: EXTENSION_DIGEST, extensionFactories: [() => undefined] }] })),
      dispose: vi.fn(async () => undefined),
    };
    const createAgentSessionFn = vi.fn(async () => {
      throw new Error("PI_SDK_START_FAILED");
    }) as unknown as typeof createAgentSession;
    try {
      await expect(createPiRuntime({
        context,
        record: sessionRecord,
        sandbox,
        provider: {} as never,
        history: [],
        resources: resources(),
        resourceMaterializer: materializer,
        createAgentSessionFn,
      })).rejects.toThrow("PI_SDK_START_FAILED");
      expect(materializer.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
