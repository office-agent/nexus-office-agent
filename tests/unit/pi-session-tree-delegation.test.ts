// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { DelegationService, LocalPiChildSessionFactory } from "@/src/modules/pi-agent/application/delegation-service";
import { SessionTreeService } from "@/src/modules/pi-agent/application/session-tree-service";
import { StaticAgentProfileRegistry } from "@/src/modules/pi-agent/application/profile-registry";
import { InMemoryPiDelegationStore } from "@/src/modules/pi-agent/infrastructure/delegation-store";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { InMemoryPiSessionTreeStore } from "@/src/modules/pi-agent/infrastructure/session-tree-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";

const context = (actorId = "actor-a", tenantId = "tenant-a"): RequestContext => ({
  tenantId,
  actorId,
  sessionId: "request-session",
  channel: "web",
  traceId: `tree-${tenantId}-${actorId}`,
  roles: [],
  permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:session:branch", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute", "pi:delegation:create", "pi:delegation:cancel"],
  dataScopes: [{ type: "tenant" }],
});

async function createSession(store: InMemoryPiSessionStore, actor = "actor-a", tenant = "tenant-a") {
  return new PiAgentService(store, new VirtualSandboxProvider()).createSession(context(actor, tenant), { profile: "coding", workspaceId: "workspace-a" });
}

describe("Pi session tree and delegation control plane", () => {
  it("creates an immutable fork, materializes only its branch history and records deterministic compaction", async () => {
    const sessionStore = new InMemoryPiSessionStore();
    const session = await createSession(sessionStore);
    const service = new SessionTreeService({ sessionStore, treeStore: new InMemoryPiSessionTreeStore() });
    const root = await service.ensureRoot(context(), session.id);
    const branch = await service.fork(context(), session.id, { parentBranchId: root.id, baseEventSequence: 1, label: "bugfix", idempotencyKey: "fork-1" });
    const repeated = await service.fork(context(), session.id, { parentBranchId: root.id, baseEventSequence: 1, label: "different-label-is-not-authoritative", idempotencyKey: "fork-1" });
    expect(repeated.id).toBe(branch.id);

    await sessionStore.appendEvent(context(), session.id, { type: "pi.assistant.completed", payload: { outputDigest: "a".repeat(64) }, traceId: context().traceId, branchId: root.id });
    const history = await service.materializeHistory(context(), session.id, branch.id);
    expect(history.events.map((event) => event.type)).toEqual(["session_created"]);
    expect(history.events.some((event) => event.type === "pi.assistant.completed")).toBe(false);

    const summary = await service.compact(context(), session.id, { branchId: root.id, idempotencyKey: "compact-1" });
    expect(summary.summaryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await service.compact(context(), session.id, { branchId: root.id, idempotencyKey: "compact-1" })).id).toBe(summary.id);
    expect((await service.verifyContinuity(context(), session.id, branch.id)).valid).toBe(true);
  });

  it("intersects child profile tools, risk, scope and budget, while default execution stays fail-closed", async () => {
    const sessionStore = new InMemoryPiSessionStore();
    const session = await createSession(sessionStore);
    const delegationStore = new InMemoryPiDelegationStore();
    const profiles = new StaticAgentProfileRegistry();
    const service = new DelegationService(sessionStore, delegationStore, profiles);
    const proposed = await service.propose(context(), { parentSessionId: session.id, profile: "coding", budget: { maxTokens: 1000 }, idempotencyKey: "child-1" });
    expect(proposed.delegation.status).toBe("proposed");
    expect(proposed.delegation.allowedTools).toContain("workspace_read");
    expect(proposed.delegation.budget.maxTokens).toBe(1000);
    await expect(service.spawnChildRun(context(), { parentSessionId: session.id, profile: "coding", idempotencyKey: "child-1" })).rejects.toThrow("PI_DELEGATION_EXECUTION_DISABLED");

    const executable = new DelegationService(sessionStore, delegationStore, profiles, new LocalPiChildSessionFactory(sessionStore), true);
    const child = await executable.spawnChildRun(context(), { parentSessionId: session.id, profile: "coding", idempotencyKey: "child-2" });
    expect(child.childSessionId).toBeDefined();
    expect((await executable.collectChildResults(context(), child.id)).terminal).toBe(false);
    expect(await executable.detectCycle(context(), child.childSessionId!)).toBe(false);
  });

  it("rejects profile escalation and prevents delegation depth explosion", async () => {
    const sessionStore = new InMemoryPiSessionStore();
    const parent = await new PiAgentService(sessionStore, new VirtualSandboxProvider()).createSession(context(), { profile: "review", workspaceId: "workspace-a" });
    const service = new DelegationService(sessionStore, new InMemoryPiDelegationStore(), new StaticAgentProfileRegistry(), new LocalPiChildSessionFactory(sessionStore), true);
    await expect(service.propose(context(), { parentSessionId: parent.id, profile: "coding", idempotencyKey: "escalation" })).rejects.toThrow("PI_DELEGATION_PROFILE_NOT_ALLOWED");

    const profiles = new StaticAgentProfileRegistry({ coding: { delegationPolicy: { maxDepth: 2, maxConcurrentChildren: 2, allowedProfiles: ["coding"], budget: { maxDurationMs: 600_000, maxOutputBytes: 2_000_000, maxTokens: 40_000, maxChildRuns: 4 } } } });
    const coding = await createSession(sessionStore);
    const store = new InMemoryPiDelegationStore();
    const executable = new DelegationService(sessionStore, store, profiles, new LocalPiChildSessionFactory(sessionStore), true);
    const first = await executable.spawnChildRun(context(), { parentSessionId: coding.id, profile: "coding", idempotencyKey: "depth-1" });
    const second = await executable.spawnChildRun(context(), { parentSessionId: first.childSessionId!, profile: "coding", idempotencyKey: "depth-2" });
    await expect(executable.propose(context(), { parentSessionId: second.childSessionId!, profile: "coding", idempotencyKey: "depth-3" })).rejects.toThrow("PI_DELEGATION_DEPTH_EXCEEDED");
  });
});

