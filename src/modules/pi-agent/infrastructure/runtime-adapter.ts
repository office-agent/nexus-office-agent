import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiSandbox, PiSandboxProvider, PiSession, PiSessionEvent } from "@/src/modules/pi-agent/domain/contracts";
import type { PiResolvedResourceSet } from "@/src/modules/pi-agent/domain/resource-contracts";
import { getPiProfile } from "@/src/modules/pi-agent/domain/profiles";
import { createPiWorkspaceTools } from "@/src/modules/pi-agent/infrastructure/tools";
import { resolvePiModel, type PiModelBinding } from "@/src/modules/pi-agent/infrastructure/model";
import { EnterpriseResourceLoader } from "@/src/modules/pi-agent/infrastructure/resource-loader";
import type { ToolGateway } from "@/src/modules/pi-agent/application/tool-gateway";
import { createPiMcpTools } from "@/src/modules/pi-agent/infrastructure/mcp-tools";
import { PiApprovalService } from "@/src/modules/pi-agent/application/approval-service";
import type { PiApprovalObjectVersionReader, PiApprovalObjectVersions, PiApproval } from "@/src/modules/pi-agent/domain/approval-contracts";
import type { PiApprovalExecutionPermit } from "@/src/modules/pi-agent/domain/approval-contracts";
import { createPiEnterprisePolicyExtension } from "@/src/modules/pi-agent/infrastructure/enterprise-policy-extension";
import {
  assertPiMaterializationMatchesSnapshot,
  hasPiRuntimeArtifacts,
  type PiResourceMaterializer,
  type PiMaterializedResourceSet,
} from "@/src/modules/pi-agent/infrastructure/resource-materializer";

type CreateAgentSession = typeof createAgentSession;

export type PiRuntimeAdapter = {
  session: AgentSession;
  sandbox: PiSandbox;
  model?: PiModelBinding;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): Promise<void>;
};

export type PiRuntimeInput = {
  context: RequestContext;
  record: PiSession;
  sandbox: PiSandbox;
  provider: PiSandboxProvider;
  history: PiSessionEvent[];
  resources?: PiResolvedResourceSet;
  toolGateway?: ToolGateway;
  mcpBindingIds?: string[];
  /** Run identity is required whenever the Session has MCP bindings. */
  runId?: string;
  /** Install the server-owned policy extension even when no approval service is available. */
  enforceEnterprisePolicy?: boolean;
  approvalService?: PiApprovalService;
  approvalObjectVersions?: PiApprovalObjectVersions;
  approvalObjectVersionReader?: PiApprovalObjectVersionReader;
  approvalPollMs?: number;
  approvalWaitTimeoutMs?: number;
  onApprovalRequired?: (input: { approval: PiApproval; created: boolean }) => Promise<void> | void;
  onApprovalResumed?: (input: { approval: PiApproval; permit: PiApprovalExecutionPermit }) => Promise<void> | void;
  onApprovalDenied?: (input: { approval: PiApproval; reason: string }) => Promise<void> | void;
  resourceMaterializer?: PiResourceMaterializer;
  signal?: AbortSignal;
  /** Injectable only for adapter contract tests; production uses the Pi SDK. */
  createAgentSessionFn?: CreateAgentSession;
};

function restoreHistory(sessionManager: SessionManager, history: PiSessionEvent[]): void {
  for (const event of history) {
    const payload = event.payload as { entry?: { type?: string; message?: unknown } };
    if (event.type !== "entry_appended" || payload.entry?.type !== "message" || !payload.entry.message) continue;
    try { sessionManager.appendMessage(payload.entry.message as never); } catch { /* malformed history is isolated from the runner */ }
  }
}

export async function createPiRuntime(input: PiRuntimeInput): Promise<PiRuntimeAdapter> {
  const profile = getPiProfile(input.record.profile);
  const model = await resolvePiModel();
  let materialized: PiMaterializedResourceSet | undefined;
  let materializationDisposed = false;
  const disposeMaterialization = async (): Promise<void> => {
    if (!materialized || materializationDisposed || !input.resourceMaterializer?.dispose || !input.resources) return;
    materializationDisposed = true;
    await input.resourceMaterializer.dispose({
      context: input.context,
      sandbox: input.sandbox,
      resources: input.resources,
      materialized,
    });
  };
  if (input.resources && hasPiRuntimeArtifacts(input.resources)) {
    if (!input.resourceMaterializer) throw new Error("PI_RESOURCE_RUNTIME_ARTIFACT_UNAVAILABLE");
    if (input.sandbox.provider !== "firecracker" && input.sandbox.provider !== "kata") {
      throw new Error("PI_RESOURCE_RUNTIME_SANDBOX_REQUIRED");
    }
    if (input.sandbox.executionBoundary !== "guest") throw new Error("PI_RESOURCE_RUNTIME_GUEST_BOUNDARY_REQUIRED");
    try {
      materialized = await input.resourceMaterializer.materialize({
        context: input.context,
        sandbox: input.sandbox,
        resources: input.resources,
        signal: input.signal,
      });
      assertPiMaterializationMatchesSnapshot(input.resources, materialized);
    } catch (error) {
      await disposeMaterialization().catch(() => undefined);
      throw error;
    }
  }
  const sessionManager = SessionManager.inMemory(input.sandbox.root);
  restoreHistory(sessionManager, input.history);
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  const enterpriseExtensions: InlineExtension[] = (input.enforceEnterprisePolicy || input.approvalService)
    ? [{
      name: "enterprise-policy",
      hidden: true,
      factory: createPiEnterprisePolicyExtension({
        context: input.context,
        record: input.record,
        runId: input.runId ?? input.record.sandboxRunId,
        approvalService: input.approvalService,
        approvalObjectVersions: input.approvalObjectVersions,
        approvalObjectVersionReader: input.approvalObjectVersionReader,
        pollMs: input.approvalPollMs,
        waitTimeoutMs: input.approvalWaitTimeoutMs,
        onApprovalRequired: input.onApprovalRequired,
        onApprovalResumed: input.onApprovalResumed,
        onApprovalDenied: input.onApprovalDenied,
      }),
    }]
    : [];
  const resourceOptions = {
    cwd: input.sandbox.root,
    agentDir: input.sandbox.root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: enterpriseExtensions,
    systemPrompt: [
      "You are the enterprise Pi coding agent.",
      "All actions are constrained by the server policy and current isolated sandbox.",
      "Never claim a command ran unless the tool result confirms it.",
      "Never access credentials, host paths, other tenants, or unregistered skills/MCP servers.",
      `Current profile: ${input.record.profile}. Workspace: ${input.record.workspaceId}. Network: ${input.record.networkPolicy}.`,
    ].join("\n"),
  };
  const resourceLoader = input.resources
    ? new EnterpriseResourceLoader({ cwd: input.sandbox.root, agentDir: input.sandbox.root, resources: input.resources, materialized, systemPrompt: resourceOptions.systemPrompt, extensionFactories: enterpriseExtensions })
    : new DefaultResourceLoader(resourceOptions);
  const mcpBindingIds = input.mcpBindingIds ?? [];
  if (mcpBindingIds.length > 0 && !input.toolGateway) throw new Error("PI_MCP_TOOL_GATEWAY_UNAVAILABLE");
  if (mcpBindingIds.length > 0 && !input.runId) throw new Error("PI_MCP_EXECUTION_SCOPE_REQUIRED");
  const mcpTools = mcpBindingIds.length > 0
    ? await createPiMcpTools({ context: input.context, profile: input.record.profile, gateway: input.toolGateway!, bindingIds: mcpBindingIds, sessionId: input.record.id, runId: input.runId! })
    : [];
  const createSession = input.createAgentSessionFn ?? createAgentSession;
  let session: AgentSession;
  try {
    ({ session } = await createSession({
      modelRuntime: model?.runtime,
      model: model?.model,
      resourceLoader,
      sessionManager,
      settingsManager,
      tools: profile.allowedTools,
      customTools: [...createPiWorkspaceTools({ context: input.context, profile: input.record.profile, sandbox: input.sandbox, provider: input.provider }), ...mcpTools],
      noTools: "builtin",
    }));
  } catch (error) {
    await disposeMaterialization().catch(() => undefined);
    throw error;
  }
  return {
    session,
    sandbox: input.sandbox,
    model,
    subscribe(listener) { return session.subscribe(listener); },
    async dispose() {
      await session.abort().catch(() => undefined);
      await disposeMaterialization();
    },
  };
}
