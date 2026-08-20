// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiProfileId } from "@/src/modules/pi-agent/domain/contracts";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { InMemoryPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import {
  InMemoryPiGitCredentialBroker,
  VirtualPiWorkspaceProvider,
} from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { InMemoryPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";
import { InMemoryPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";

const TENANT_ID = "10000000-0000-4000-8000-000000000101";
const ACTOR_ID = "10000000-0000-4000-8000-000000000102";
const BASE_COMMIT = "a".repeat(40);

type JourneyCase = {
  kind: string;
  profile: PiProfileId;
  change: string;
  report?: boolean;
  readOnly?: boolean;
  push?: boolean;
};

const journeyCases: readonly JourneyCase[] = [
  { kind: "new_feature", profile: "coding", change: "add feature" },
  { kind: "bug_fix", profile: "debug", change: "fix bug" },
  { kind: "refactor", profile: "refactor", change: "refactor module" },
  { kind: "test_failure_repair", profile: "debug", change: "repair failing test", report: true },
  { kind: "code_review", profile: "review", change: "review diff", readOnly: true },
  { kind: "pull_request", profile: "coding", change: "prepare pull request", push: true },
];

function context(sessionId: string, permissions: string[]): RequestContext {
  return {
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    sessionId,
    channel: "web",
    traceId: `trace-${sessionId}`,
    roles: [],
    permissions,
    dataScopes: [{ type: "tenant" }],
  };
}

function permissionsFor(testCase: JourneyCase): string[] {
  const permissions = ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read"];
  if (!testCase.readOnly) permissions.push("pi:workspace:write");
  if (testCase.profile === "debug" || testCase.profile === "refactor") permissions.push("pi:sandbox:execute");
  if (testCase.push) permissions.push("pi:change:submit");
  return permissions;
}

function repository() {
  return {
    id: "repo-vibe-coding",
    tenantId: TENANT_ID,
    workspaceId: "workspace-vibe-coding",
    provider: "forgejo" as const,
    repositoryRef: "engineering/vibe-coding",
    defaultBranch: "main",
    credentialRef: "opaque://server-managed",
    status: "active" as const,
    createdAt: new Date(0).toISOString(),
  };
}

async function fixture() {
  const sessions = new InMemoryPiSessionStore();
  const runs = new InMemoryPiRunStore();
  const agent = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
  const provider = new VirtualPiWorkspaceProvider();
  const store = new InMemoryPiWorkspaceStore();
  const objects = new InMemoryPiObjectStorageGateway();
  await store.putRepository(repository());
  const workspaceService = new PiWorkspaceService({
    store,
    provider,
    credentialBroker: new InMemoryPiGitCredentialBroker(),
    objectStorage: objects,
    sessionStore: sessions,
  });
  return { agent, provider, sessions, store, objects, workspaceService };
}

async function runJourney(testCase: JourneyCase) {
  const sessionId = `session-${testCase.kind}`;
  const actorContext = context(sessionId, permissionsFor(testCase));
  const state = await fixture();
  const ownerContext = testCase.readOnly ? context(`${sessionId}-owner`, permissionsFor({ kind: "new_feature", profile: "coding", change: "workspace owner" })) : actorContext;
  const ownerSession = await state.agent.createSession(ownerContext, {
    profile: testCase.readOnly ? "coding" : testCase.profile,
    workspaceId: "workspace-vibe-coding",
    repositoryId: "repo-vibe-coding",
    baseRef: "main",
    baseCommit: BASE_COMMIT,
  });
  const session = testCase.readOnly ? await state.agent.createSession(actorContext, {
    profile: testCase.profile,
    workspaceId: "workspace-vibe-coding",
    repositoryId: "repo-vibe-coding",
    baseRef: "main",
    baseCommit: BASE_COMMIT,
  }) : ownerSession;
  const runId = `run-${testCase.kind}`;
  const prepared = await state.workspaceService.prepareWorkspace(ownerContext, {
    sessionId: ownerSession.id,
    runId,
    workspaceId: "workspace-vibe-coding",
    repositoryId: "repo-vibe-coding",
    baseRef: "main",
    baseCommitSha: BASE_COMMIT,
    profile: testCase.profile,
  });
  expect(prepared.status).toBe("ready");
  expect(prepared.baseCommitSha).toBe(BASE_COMMIT);
  expect(prepared.ephemeralBranch).toMatch(/^pi\//);
  expect(prepared.providerWorkspaceRef).toMatch(/^virtual:\/\//);

  if (testCase.readOnly) {
    state.provider.seedDiff(prepared.providerWorkspaceRef!, `diff --git a/review.md b/review.md\n+review: ${testCase.change}\n`);
    const diff = await state.workspaceService.computeDiff(actorContext, prepared.id);
    expect(diff.baseCommitSha).toBe(BASE_COMMIT);
    expect(diff.diff).toContain(testCase.change);
    expect(diff.truncated).toBe(false);
    await expect(state.workspaceService.checkpoint(actorContext, prepared.id, "review-must-not-write")).rejects.toThrow("POLICY_DENIED:pi:workspace:write");
  } else {
    state.provider.seedDiff(prepared.providerWorkspaceRef!, `diff --git a/src/${testCase.kind}.ts b/src/${testCase.kind}.ts\n+change: ${testCase.change}\n`);
    const diff = await state.workspaceService.computeDiff(actorContext, prepared.id);
    expect(diff.baseCommitSha).toBe(BASE_COMMIT);
    expect(diff.diffDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(diff.diff).toContain(testCase.change);

    if (testCase.report) {
      const report = await state.workspaceService.registerArtifact(actorContext, {
        sessionId: session.id,
        runId,
        workspaceRecordId: prepared.id,
        type: "test_report",
        fileName: "test-report.json",
        mediaType: "application/json",
        classification: "internal",
        bytes: new TextEncoder().encode(JSON.stringify({ status: "passed", journey: testCase.kind })),
      });
      expect(report.type).toBe("test_report");
      expect(report.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    }

    const checkpoint = await state.workspaceService.checkpoint(actorContext, prepared.id, testCase.change);
    expect(checkpoint.workspace.status).toBe("ready");
    expect(checkpoint.commit.branch).toBe(prepared.ephemeralBranch);
    expect(checkpoint.commit.commitSha).toMatch(/^[a-f0-9]{64}$/);
    if (testCase.push) {
      const pushed = await state.workspaceService.pushBranch(actorContext, prepared.id);
      expect(pushed.branch).toBe(prepared.ephemeralBranch);
      expect(pushed.headCommitSha).toBe(checkpoint.commit.commitSha);
    }
  }

  const artifacts = await state.workspaceService.listArtifacts(actorContext, session.id);
  expect(artifacts.every((artifact) => artifact.tenantId === TENANT_ID && artifact.sessionId === session.id)).toBe(true);
  const destroyed = await state.workspaceService.cleanupWorkspace(ownerContext, prepared.id);
  expect(destroyed.status).toBe("destroyed");
  await expect(state.workspaceService.getWorkspace(actorContext, prepared.id)).resolves.toMatchObject({ status: "destroyed" });
  return { kind: testCase.kind, status: destroyed.status, artifactCount: artifacts.length };
}

describe("Pi Vibe Coding local journeys", () => {
  it.each(journeyCases)("completes the $kind journey through the workspace contract", async (testCase) => {
    await expect(runJourney(testCase)).resolves.toMatchObject({ kind: testCase.kind, status: "destroyed" });
  });

  it("fails closed when a journey cannot clean up its workspace", async () => {
    const state = await fixture();
    const actorContext = context("session-cleanup-failure", permissionsFor({ kind: "new_feature", profile: "coding", change: "cleanup" }));
    const session = await state.agent.createSession(actorContext, {
      profile: "coding",
      workspaceId: "workspace-vibe-coding",
      repositoryId: "repo-vibe-coding",
      baseRef: "main",
      baseCommit: BASE_COMMIT,
    });
    const prepared = await state.workspaceService.prepareWorkspace(actorContext, {
      sessionId: session.id,
      runId: "run-cleanup-failure",
      workspaceId: "workspace-vibe-coding",
      repositoryId: "repo-vibe-coding",
      baseRef: "main",
      baseCommitSha: BASE_COMMIT,
      profile: "coding",
    });
    const originalCleanup = state.provider.cleanupWorkspace.bind(state.provider);
    state.provider.cleanupWorkspace = async () => { throw new Error("PROVIDER_CLEANUP_FAILED"); };
    await expect(state.workspaceService.cleanupWorkspace(actorContext, prepared.id)).rejects.toThrow("PI_WORKSPACE_CLEANUP_UNKNOWN");
    await expect(state.workspaceService.getWorkspace(actorContext, prepared.id)).resolves.toMatchObject({ status: "unknown", failureCode: "PI_WORKSPACE_CLEANUP_UNKNOWN" });
    state.provider.cleanupWorkspace = originalCleanup;
  });
});
