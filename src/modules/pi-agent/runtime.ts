import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { InMemoryPiRunStore, PostgresPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { createPiSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { InMemoryPiWorkspaceStore, PostgresPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";
import { createPiGitCredentialBroker, createPiWorkspaceProvider } from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { createPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";
import { PiResourceRegistryService, createPiResourceRegistry } from "@/src/modules/pi-agent/application/resource-registry";
import { InMemoryPiResourceRegistryStore, PostgresPiResourceRegistryStore } from "@/src/modules/pi-agent/infrastructure/resource-store";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { createMcpRegistry, McpRegistryService } from "@/src/modules/pi-agent/application/mcp-registry";
import { InMemoryMcpRegistryStore, PostgresMcpAuditScopeReadinessStore, PostgresMcpRegistryStore } from "@/src/modules/pi-agent/infrastructure/mcp-store";
import { ApprovalPolicyResolver, FailClosedPiApprovalApproverDirectory, InMemoryPiApprovalEventSink, PiApprovalService } from "@/src/modules/pi-agent/application/approval-service";
import { InMemoryPiApprovalStore, PostgresPiApprovalStore } from "@/src/modules/pi-agent/infrastructure/approval-store";
import { PostgresPiApprovalEventSink } from "@/src/modules/pi-agent/infrastructure/approval-events";
import { SessionTreeService } from "@/src/modules/pi-agent/application/session-tree-service";
import { StaticAgentProfileRegistry, PostgresAgentProfileRegistry } from "@/src/modules/pi-agent/application/profile-registry";
import { DelegationService } from "@/src/modules/pi-agent/application/delegation-service";
import { InMemoryPiSessionTreeStore, PostgresPiSessionTreeStore } from "@/src/modules/pi-agent/infrastructure/session-tree-store";
import { InMemoryPiDelegationStore, PostgresPiDelegationStore } from "@/src/modules/pi-agent/infrastructure/delegation-store";
import { EnterpriseModelGateway } from "@/src/modules/pi-agent/application/model-gateway";
import { PiTelemetryService } from "@/src/modules/pi-agent/application/telemetry-evaluation";
import { PiQuotaService } from "@/src/modules/pi-agent/application/quota-service";
import { InMemoryPiModelRouteStore, InMemoryPiObservabilityStore, InMemoryPiQuotaStore, PostgresPiM30Store } from "@/src/modules/pi-agent/infrastructure/m30-store";
import { PiSecurityResilienceService } from "@/src/modules/pi-agent/application/security-resilience";
import { InMemoryPiSecurityResilienceStore, PostgresPiSecurityResilienceStore } from "@/src/modules/pi-agent/infrastructure/m31-store";
import { CompositePiPreproductionProbe, FailClosedPiPreproductionProbe, McpAuditScopePreproductionProbe, PiPreproductionService } from "@/src/modules/pi-agent/application/preproduction-service";
import { InMemoryPiPreproductionStore, PostgresPiPreproductionStore } from "@/src/modules/pi-agent/infrastructure/m32-store";
import { PiPilotService } from "@/src/modules/pi-agent/application/pilot-service";
import { InMemoryPiPilotStore, PostgresPiPilotStore } from "@/src/modules/pi-agent/infrastructure/m33-store";
import { PiReleaseGovernanceService } from "@/src/modules/pi-agent/application/release-governance-service";
import { InMemoryPiReleaseGovernanceStore, PostgresPiReleaseGovernanceStore } from "@/src/modules/pi-agent/infrastructure/m34-store";
import { PiChangeDeliveryService } from "@/src/modules/pi-agent/application/change-delivery-service";
import { InMemoryPiChangeDeliveryStore } from "@/src/modules/pi-agent/infrastructure/change-delivery-store";
import { PostgresPiChangeDeliveryStore } from "@/src/modules/pi-agent/infrastructure/postgres-change-delivery-store";
import { PiChangeDeliveryApprovalObjectVersionReader } from "@/src/modules/pi-agent/infrastructure/change-delivery-approval";
import { createPiChangeDeliveryGateways } from "@/src/modules/pi-agent/infrastructure/change-delivery-gateway";
import type { PiChangeDeliveryEvidenceReader } from "@/src/modules/pi-agent/domain/change-delivery-contracts";

const runtime = globalThis as typeof globalThis & {
  __nexusPiAgentService?: PiAgentService;
  __nexusPiWorkspaceService?: PiWorkspaceService;
  __nexusPiResourceRegistry?: PiResourceRegistryService;
  __nexusPiMcpRegistry?: McpRegistryService;
  __nexusPiApprovalService?: PiApprovalService;
  __nexusPiSessionTreeService?: SessionTreeService;
  __nexusPiDelegationService?: DelegationService;
  __nexusPiProfileRegistry?: StaticAgentProfileRegistry | PostgresAgentProfileRegistry;
  __nexusPiModelGateway?: EnterpriseModelGateway;
  __nexusPiTelemetryService?: PiTelemetryService;
  __nexusPiQuotaService?: PiQuotaService;
  __nexusPiSecurityResilienceService?: PiSecurityResilienceService;
  __nexusPiPreproductionService?: PiPreproductionService;
  __nexusPiPilotService?: PiPilotService;
  __nexusPiReleaseGovernanceService?: PiReleaseGovernanceService;
  __nexusPiChangeDeliveryService?: PiChangeDeliveryService;
  __nexusPiAgentRuntimeVersion?: number;
};

export function getPiAgentService(): PiAgentService {
  if (runtime.__nexusPiAgentRuntimeVersion !== 16 || !runtime.__nexusPiAgentService || !runtime.__nexusPiWorkspaceService || !runtime.__nexusPiResourceRegistry || !runtime.__nexusPiMcpRegistry || !runtime.__nexusPiApprovalService || !runtime.__nexusPiSessionTreeService || !runtime.__nexusPiDelegationService || !runtime.__nexusPiProfileRegistry || !runtime.__nexusPiModelGateway || !runtime.__nexusPiTelemetryService || !runtime.__nexusPiQuotaService || !runtime.__nexusPiSecurityResilienceService || !runtime.__nexusPiPreproductionService || !runtime.__nexusPiPilotService || !runtime.__nexusPiReleaseGovernanceService || !runtime.__nexusPiChangeDeliveryService) {
    const database = process.env.DATABASE_URL ? createPostgresDatabase(process.env.DATABASE_URL) : undefined;
    const store = database ? new PostgresPiSessionStore(database) : new InMemoryPiSessionStore();
    const runStore = database ? new PostgresPiRunStore(database) : new InMemoryPiRunStore();
    const resourceRegistry = createPiResourceRegistry(database ? new PostgresPiResourceRegistryStore(database) : new InMemoryPiResourceRegistryStore());
    const mcpRegistry = createMcpRegistry(database ? new PostgresMcpRegistryStore(database) : new InMemoryMcpRegistryStore());
    const approvalStore = database ? new PostgresPiApprovalStore(database) : new InMemoryPiApprovalStore();
    const approvalEvents = database ? new PostgresPiApprovalEventSink(database) : new InMemoryPiApprovalEventSink();
    const approvalPolicy = new ApprovalPolicyResolver(new FailClosedPiApprovalApproverDirectory(), { policyVersion: 1 });
    const treeStore = database ? new PostgresPiSessionTreeStore(database) : new InMemoryPiSessionTreeStore();
    const profileRegistry = database ? new PostgresAgentProfileRegistry(database) : new StaticAgentProfileRegistry();
    const delegationStore = database ? new PostgresPiDelegationStore(database) : new InMemoryPiDelegationStore();
    const m30Store = database ? new PostgresPiM30Store(database) : undefined;
    const m31Store = database ? new PostgresPiSecurityResilienceStore(database) : new InMemoryPiSecurityResilienceStore();
    const securityResilience = new PiSecurityResilienceService(m31Store);
    const m32Store = database ? new PostgresPiPreproductionStore(database) : new InMemoryPiPreproductionStore();
    const m33Store = database ? new PostgresPiPilotStore(database) : new InMemoryPiPilotStore();
    const m34Store = database ? new PostgresPiReleaseGovernanceStore(database) : new InMemoryPiReleaseGovernanceStore();
    runtime.__nexusPiResourceRegistry = resourceRegistry;
    runtime.__nexusPiMcpRegistry = mcpRegistry;
    runtime.__nexusPiSessionTreeService = new SessionTreeService({ sessionStore: store, treeStore });
    runtime.__nexusPiDelegationService = new DelegationService(store, delegationStore, profileRegistry, undefined, false);
    runtime.__nexusPiProfileRegistry = profileRegistry;
    runtime.__nexusPiModelGateway = new EnterpriseModelGateway({ store: m30Store ?? new InMemoryPiModelRouteStore(), safety: securityResilience });
    runtime.__nexusPiTelemetryService = new PiTelemetryService(m30Store ?? new InMemoryPiObservabilityStore());
    runtime.__nexusPiQuotaService = new PiQuotaService(m30Store ?? new InMemoryPiQuotaStore());
    runtime.__nexusPiSecurityResilienceService = securityResilience;
    const preproductionProbe = database
      ? new CompositePiPreproductionProbe([new FailClosedPiPreproductionProbe(), new McpAuditScopePreproductionProbe(new PostgresMcpAuditScopeReadinessStore(database))])
      : new FailClosedPiPreproductionProbe();
    runtime.__nexusPiPreproductionService = new PiPreproductionService(m32Store, preproductionProbe);
    runtime.__nexusPiPilotService = new PiPilotService(m33Store);
    runtime.__nexusPiReleaseGovernanceService = new PiReleaseGovernanceService(m34Store);
    runtime.__nexusPiAgentService = new PiAgentService(store, createPiSandboxProvider(), runStore, resourceRegistry, mcpRegistry);
    const workspaceService = new PiWorkspaceService({
      store: database ? new PostgresPiWorkspaceStore(database) : new InMemoryPiWorkspaceStore(),
      provider: createPiWorkspaceProvider(),
      credentialBroker: createPiGitCredentialBroker(),
      objectStorage: createPiObjectStorageGateway(),
      sessionStore: store,
    });
    runtime.__nexusPiWorkspaceService = workspaceService;
    const changeEvidence: PiChangeDeliveryEvidenceReader = {
      getRepository: workspaceService.getRepository.bind(workspaceService),
      getWorkspace: workspaceService.getWorkspace.bind(workspaceService),
      deliveryDiff: workspaceService.deliveryDiff.bind(workspaceService),
      checkpoints: workspaceService.checkpoints.bind(workspaceService),
      listArtifacts: workspaceService.listArtifacts.bind(workspaceService),
    };
    const changeStore = database ? new PostgresPiChangeDeliveryStore(database) : new InMemoryPiChangeDeliveryStore();
    const changeObjectVersions = new PiChangeDeliveryApprovalObjectVersionReader(changeStore, changeEvidence);
    runtime.__nexusPiApprovalService = new PiApprovalService(approvalStore, approvalPolicy, approvalEvents, changeObjectVersions);
    const gateways = createPiChangeDeliveryGateways();
    runtime.__nexusPiChangeDeliveryService = new PiChangeDeliveryService(changeStore, changeEvidence, runtime.__nexusPiApprovalService, gateways.pullRequests, gateways.releases);
    runtime.__nexusPiAgentRuntimeVersion = 16;
  }
  return runtime.__nexusPiAgentService;
}

export function getPiMcpRegistry(): McpRegistryService {
  getPiAgentService();
  if (!runtime.__nexusPiMcpRegistry) throw new Error("PI_MCP_REGISTRY_NOT_READY");
  return runtime.__nexusPiMcpRegistry;
}

export function getPiResourceRegistry(): PiResourceRegistryService {
  getPiAgentService();
  if (!runtime.__nexusPiResourceRegistry) throw new Error("PI_RESOURCE_REGISTRY_NOT_READY");
  return runtime.__nexusPiResourceRegistry;
}

export function getPiApprovalService(): PiApprovalService {
  getPiAgentService();
  if (!runtime.__nexusPiApprovalService) throw new Error("PI_APPROVAL_RUNTIME_NOT_READY");
  return runtime.__nexusPiApprovalService;
}

export function getPiWorkspaceService(): PiWorkspaceService {
  getPiAgentService();
  if (!runtime.__nexusPiWorkspaceService) throw new Error("PI_WORKSPACE_RUNTIME_NOT_READY");
  return runtime.__nexusPiWorkspaceService;
}

export function getPiSessionTreeService(): SessionTreeService {
  getPiAgentService();
  if (!runtime.__nexusPiSessionTreeService) throw new Error("PI_SESSION_TREE_RUNTIME_NOT_READY");
  return runtime.__nexusPiSessionTreeService;
}

export function getPiDelegationService(): DelegationService {
  getPiAgentService();
  if (!runtime.__nexusPiDelegationService) throw new Error("PI_DELEGATION_RUNTIME_NOT_READY");
  return runtime.__nexusPiDelegationService;
}

export function getPiProfileRegistry(): StaticAgentProfileRegistry | PostgresAgentProfileRegistry {
  getPiAgentService();
  if (!runtime.__nexusPiProfileRegistry) throw new Error("PI_PROFILE_REGISTRY_NOT_READY");
  return runtime.__nexusPiProfileRegistry;
}

export function getPiModelGateway(): EnterpriseModelGateway {
  getPiAgentService();
  if (!runtime.__nexusPiModelGateway) throw new Error("PI_MODEL_GATEWAY_NOT_READY");
  return runtime.__nexusPiModelGateway;
}

export function getPiTelemetryService(): PiTelemetryService {
  getPiAgentService();
  if (!runtime.__nexusPiTelemetryService) throw new Error("PI_TELEMETRY_NOT_READY");
  return runtime.__nexusPiTelemetryService;
}

export function getPiQuotaService(): PiQuotaService {
  getPiAgentService();
  if (!runtime.__nexusPiQuotaService) throw new Error("PI_QUOTA_NOT_READY");
  return runtime.__nexusPiQuotaService;
}

export function getPiSecurityResilienceService(): PiSecurityResilienceService {
  getPiAgentService();
  if (!runtime.__nexusPiSecurityResilienceService) throw new Error("PI_SECURITY_RESILIENCE_NOT_READY");
  return runtime.__nexusPiSecurityResilienceService;
}

export function getPiPreproductionService(): PiPreproductionService {
  getPiAgentService();
  if (!runtime.__nexusPiPreproductionService) throw new Error("PI_PREPRODUCTION_RUNTIME_NOT_READY");
  return runtime.__nexusPiPreproductionService;
}

export function getPiPilotService(): PiPilotService {
  getPiAgentService();
  if (!runtime.__nexusPiPilotService) throw new Error("PI_PILOT_RUNTIME_NOT_READY");
  return runtime.__nexusPiPilotService;
}

export function getPiReleaseGovernanceService(): PiReleaseGovernanceService {
  getPiAgentService();
  if (!runtime.__nexusPiReleaseGovernanceService) throw new Error("PI_RELEASE_GOVERNANCE_RUNTIME_NOT_READY");
  return runtime.__nexusPiReleaseGovernanceService;
}

export function getPiChangeDeliveryService(): PiChangeDeliveryService {
  getPiAgentService();
  if (!runtime.__nexusPiChangeDeliveryService) throw new Error("PI_CHANGE_DELIVERY_RUNTIME_NOT_READY");
  return runtime.__nexusPiChangeDeliveryService;
}
