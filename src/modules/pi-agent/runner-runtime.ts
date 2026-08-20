import { randomUUID } from "node:crypto";
import { PiRunnerWorker } from "@/src/modules/pi-agent/application/runner";
import { SandboxOrchestrator } from "@/src/modules/pi-agent/application/sandbox-orchestrator";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { createPiSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { PostgresPiSandboxRunStore } from "@/src/modules/pi-agent/infrastructure/sandbox-run-store";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { PostgresPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";
import { createPiGitCredentialBroker, createPiWorkspaceProvider } from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { createPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";
import { createPiResourceRegistry } from "@/src/modules/pi-agent/application/resource-registry";
import { PostgresPiResourceRegistryStore } from "@/src/modules/pi-agent/infrastructure/resource-store";
import { createMcpCredentialBroker, createMcpRegistry } from "@/src/modules/pi-agent/application/mcp-registry";
import { HttpMcpTransport, McpBridge } from "@/src/modules/pi-agent/application/mcp-bridge";
import { PolicyDecisionPoint, ToolGateway } from "@/src/modules/pi-agent/application/tool-gateway";
import { PostgresMcpAuditStore, PostgresMcpRegistryStore } from "@/src/modules/pi-agent/infrastructure/mcp-store";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { PostgresTenantDirectory, PostgresWorkerHeartbeatRepository } from "@/src/platform/workers/postgres-work-repositories";
import { WorkerSupervisor } from "@/src/platform/workers/supervisor";
import { createPiRunnerFaultInjector } from "@/src/modules/pi-agent/application/runner-faults";
import { createCooperativePiRuntime } from "@/src/modules/pi-agent/infrastructure/cooperative-test-runtime";
import { ApprovalPolicyResolver, FailClosedPiApprovalApproverDirectory, PiApprovalService } from "@/src/modules/pi-agent/application/approval-service";
import { PostgresPiApprovalStore } from "@/src/modules/pi-agent/infrastructure/approval-store";
import { PostgresPiApprovalEventSink } from "@/src/modules/pi-agent/infrastructure/approval-events";
import { PiRuntimeApprovalObjectVersionReader } from "@/src/modules/pi-agent/infrastructure/pi-runtime-approval";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("WORKER_CONFIGURATION_INVALID");
  return parsed;
}

export function createPiRunnerRuntime() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  const cooperativeTestRuntime = process.env.NEXUS_PI_TEST_RUNTIME === "cooperative";
  if (process.env.NODE_ENV === "production" && cooperativeTestRuntime) throw new Error("PI_TEST_RUNTIME_FORBIDDEN");
  const database = createPostgresDatabase(databaseUrl);
  const leaseMs = positiveInteger(process.env.WORKER_LEASE_MS, 30_000);
  const maxTenantConcurrency = positiveInteger(process.env.WORKER_MAX_CONCURRENT_PER_TENANT, 1);
  const sandboxProvider = createPiSandboxProvider();
  if (process.env.NODE_ENV === "production" && sandboxProvider.kind === "unavailable") throw new Error("PI_SANDBOX_RUNTIME_NOT_READY");
  const workspaceProvider = createPiWorkspaceProvider();
  if (process.env.NODE_ENV === "production" && workspaceProvider.kind === "unavailable") throw new Error("PI_WORKSPACE_RUNTIME_NOT_READY");
  const sessionStore = new PostgresPiSessionStore(database);
  const runStore = new PostgresPiRunStore(database);
  const workspaceService = cooperativeTestRuntime ? undefined : new PiWorkspaceService({
    store: new PostgresPiWorkspaceStore(database),
    provider: workspaceProvider,
    credentialBroker: createPiGitCredentialBroker(),
    objectStorage: createPiObjectStorageGateway(),
    sessionStore: new PostgresPiSessionStore(database),
  });
  const resourceRegistry = createPiResourceRegistry(new PostgresPiResourceRegistryStore(database));
  const mcpTransport = new HttpMcpTransport();
  const mcpCredentialBroker = createMcpCredentialBroker();
  const mcpRegistry = createMcpRegistry(new PostgresMcpRegistryStore(database), { transport: mcpTransport, credentialBroker: mcpCredentialBroker });
  const toolGateway = new ToolGateway(new PolicyDecisionPoint(mcpRegistry), new McpBridge(mcpRegistry, mcpTransport, mcpCredentialBroker, new PostgresMcpAuditStore(database)));
  const approvalObjectVersionReader = new PiRuntimeApprovalObjectVersionReader(sessionStore, runStore);
  const approvalService = new PiApprovalService(
    new PostgresPiApprovalStore(database),
    new ApprovalPolicyResolver(new FailClosedPiApprovalApproverDirectory(), { policyVersion: 1 }),
    new PostgresPiApprovalEventSink(database),
    approvalObjectVersionReader,
  );
  const faultInjector = createPiRunnerFaultInjector();
  const runtimeFactory = cooperativeTestRuntime ? createCooperativePiRuntime : undefined;
  const sandboxOrchestrator = new SandboxOrchestrator(sandboxProvider, new PostgresPiSandboxRunStore(database), faultInjector);
  const worker = new PiRunnerWorker(
    sessionStore,
    runStore,
    sandboxProvider,
    { leaseMs, maxTenantConcurrency, maxDurationMs: positiveInteger(process.env.PI_RUN_MAX_DURATION_MS, 10 * 60 * 1000), sandboxOrchestrator, workspaceService, resourceRegistry, toolGateway, approvalService, approvalObjectVersionReader, approvalPollMs: positiveInteger(process.env.PI_APPROVAL_POLL_MS, 250), approvalWaitTimeoutMs: positiveInteger(process.env.PI_APPROVAL_WAIT_TIMEOUT_MS, 15 * 60 * 1000), faultInjector, runtimeFactory },
  );
  const supervisor = new WorkerSupervisor(
    new PostgresTenantDirectory(database),
    new PostgresWorkerHeartbeatRepository(database),
    [worker],
    {
      instanceId: process.env.WORKER_INSTANCE_ID ?? `${process.pid}-${randomUUID().slice(0, 8)}`,
      releaseVersion: process.env.NEXUS_RELEASE_VERSION ?? "0.15.0-pi-runner-spike",
      pollIntervalMs: positiveInteger(process.env.WORKER_POLL_INTERVAL_MS, 500),
      heartbeatIntervalMs: positiveInteger(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 10_000),
      maxItemsPerRolePerCycle: positiveInteger(process.env.WORKER_MAX_ITEMS_PER_ROLE, 32),
    },
  );
  return { database, supervisor };
}
