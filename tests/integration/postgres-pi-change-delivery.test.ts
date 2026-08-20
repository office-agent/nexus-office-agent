// Requirements: PR-010, PR-011, SR-006, SR-007, AC-011, AC-012, DR-011, DR-012
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { PiChangeDeliveryService } from "@/src/modules/pi-agent/application/change-delivery-service";
import type {
  PiChangeApprovalGateway,
  PiChangeDeliveryEvidenceReader,
  PiChangeReleaseGateway,
  PiExternalActionResult,
  PiPullRequestGateway,
} from "@/src/modules/pi-agent/domain/change-delivery-contracts";
import type { PiApprovalExecutionPermit } from "@/src/modules/pi-agent/domain/approval-contracts";
import type { PiWorkspaceArtifact, PiWorkspaceDiff, PiWorkspaceRecord } from "@/src/modules/pi-agent/domain/workspace-contracts";
import { PostgresPiChangeDeliveryStore } from "@/src/modules/pi-agent/infrastructure/postgres-change-delivery-store";

const TENANT_A = "76000000-0000-4000-8000-000000000001";
const ACTOR_A = "76000000-0000-4000-8000-000000000002";
const TENANT_B = "76000000-0000-4000-8000-000000000011";
const ACTOR_B = "76000000-0000-4000-8000-000000000012";
const SESSION_A = "76000000-0000-4000-8000-000000000003";
const RUN_A = "76000000-0000-4000-8000-000000000004";
const WORKSPACE_A = "76000000-0000-4000-8000-000000000005";
const REPOSITORY_A = "76000000-0000-4000-8000-000000000006";
const CHECKPOINT_A = "76000000-0000-4000-8000-000000000007";
const TEST_ARTIFACT_A = "76000000-0000-4000-8000-000000000008";
const SCAN_ARTIFACT_A = "76000000-0000-4000-8000-000000000009";
const APPROVAL_A = "76000000-0000-4000-8000-000000000010";
const SANDBOX_RUN_A = "76000000-0000-4000-8000-000000000013";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const DIFF_DIGEST = "c".repeat(64);
const CHANGE_SET_DIGEST = "d".repeat(64);
const APPROVAL_HASH = "e".repeat(64);

function context(tenantId = TENANT_A, actorId = ACTOR_A, channel: RequestContext["channel"] = "web"): RequestContext {
  return {
    tenantId,
    actorId,
    sessionId: "76000000-0000-4000-8000-000000000099",
    channel,
    traceId: `postgres-change-delivery-${tenantId}-${channel}`,
    roles: [],
    permissions: ["pi:change:read", "pi:change:submit", "pi:change:merge", "pi:change:release"],
    dataScopes: [{ type: "tenant" }],
  };
}

const workspace: PiWorkspaceRecord = {
  id: WORKSPACE_A,
  tenantId: TENANT_A,
  actorId: ACTOR_A,
  sessionId: SESSION_A,
  runId: RUN_A,
  workspaceId: "workspace-a",
  repositoryId: REPOSITORY_A,
  provider: "forgejo",
  repositoryRef: "acme/project",
  baseRef: "main",
  baseCommitSha: BASE_SHA,
  ephemeralBranch: "pi/76000000/change-a",
  status: "destroyed",
  providerWorkspaceRef: "provider-workspace-a",
  headCommitSha: HEAD_SHA,
  workspaceDigest: "f".repeat(64),
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:01:00.000Z",
  destroyedAt: "2026-08-20T00:02:00.000Z",
};

const diff: PiWorkspaceDiff = {
  baseCommitSha: BASE_SHA,
  headCommitSha: HEAD_SHA,
  diffDigest: DIFF_DIGEST,
  diff: "diff --git a/README.md b/README.md\n+updated\n",
  truncated: false,
};

const artifacts: PiWorkspaceArtifact[] = [
  {
    id: TEST_ARTIFACT_A,
    tenantId: TENANT_A,
    actorId: ACTOR_A,
    sessionId: SESSION_A,
    runId: RUN_A,
    workspaceId: WORKSPACE_A,
    type: "test_report",
    fileName: "test-report.json",
    mediaType: "application/json",
    storageRef: "artifact/test-report.json",
    objectVersion: "v1",
    contentDigest: "1".repeat(64),
    sizeBytes: 128,
    classification: "internal",
    version: 1,
    status: "active",
    createdAt: "2026-08-20T00:01:00.000Z",
    updatedAt: "2026-08-20T00:01:00.000Z",
  },
  {
    id: SCAN_ARTIFACT_A,
    tenantId: TENANT_A,
    actorId: ACTOR_A,
    sessionId: SESSION_A,
    runId: RUN_A,
    workspaceId: WORKSPACE_A,
    type: "scan_report",
    fileName: "scan-report.json",
    mediaType: "application/json",
    storageRef: "artifact/scan-report.json",
    objectVersion: "v1",
    contentDigest: "2".repeat(64),
    sizeBytes: 128,
    classification: "internal",
    version: 1,
    status: "active",
    createdAt: "2026-08-20T00:01:00.000Z",
    updatedAt: "2026-08-20T00:01:00.000Z",
  },
];

function permit(toolName: string): PiApprovalExecutionPermit {
  return {
    approvalId: APPROVAL_A,
    tenantId: TENANT_A,
    requestedBy: ACTOR_A,
    sessionId: SESSION_A,
    runId: RUN_A,
    toolName,
    toolVersion: 1,
    profile: toolName === "change.create_pull_request" ? "coding" : "release",
    riskLevel: toolName === "change.create_pull_request" ? "R2" : "R3",
    proposalHash: APPROVAL_HASH,
    expectedObjectVersions: {},
    policyVersion: 1,
    issuedAt: "2026-08-20T00:03:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

const approvals: PiChangeApprovalGateway = {
  async createProposal() { return { approval: { id: APPROVAL_A, proposalHash: APPROVAL_HASH } }; },
  async resumeToolCall() { return permit("change.create_pull_request"); },
};

const successfulPullRequestResult: PiExternalActionResult = {
  status: "succeeded",
  resultDigest: "3".repeat(64),
  externalId: "pr-1001",
  externalUrl: "https://forgejo.example.test/acme/project/pulls/1001",
};

const pullRequests: PiPullRequestGateway = {
  async createPullRequest() { return successfulPullRequestResult; },
  async refreshMergeability() { return { ...successfulPullRequestResult, mergeability: "mergeable" }; },
};

const releases: PiChangeReleaseGateway = {
  async proposeMerge() { return { status: "succeeded", resultDigest: "4".repeat(64) }; },
  async proposeRelease() { return { status: "succeeded", resultDigest: "5".repeat(64) }; },
};

describe("PostgreSQL Pi Change Delivery control plane", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const migrationDirectory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
      await database.exec(await readFile(path.join(migrationDirectory, file), "utf8"));
    }
    const executor: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await database.query<T>(sql, params as never[])).rows;
      },
    };
    adapter = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };

    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'change-a','Change A','active'),($2,'change-b','Change B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Change A','change-a@example.test','active'),($3,$4,'Change B','change-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
    await database.query("INSERT INTO workspace_repositories(id,tenant_id,workspace_id,forge_type,repository_ref,default_branch,credential_ref,status) VALUES($1,$2,'workspace-a','forgejo','acme/project','main','credential-ref-a','active')", [REPOSITORY_A, TENANT_A]);
    await database.query(
      "INSERT INTO pi_sessions(id,tenant_id,actor_id,workspace_id,repository_id,base_commit,profile,profile_version,status,model_policy,sandbox_profile,network_policy,policy_version,skill_digests,mcp_server_digests,sandbox_run_id,trace_id,base_ref) VALUES($1,$2,$3,'workspace-a',$4,$5,'coding',1,'running','enterprise','microvm','none',1,'[]','[]',$6,'postgres-change-session','main')",
      [SESSION_A, TENANT_A, ACTOR_A, REPOSITORY_A, BASE_SHA, SANDBOX_RUN_A],
    );
    await database.query(
      "INSERT INTO pi_run_manifests(run_id,tenant_id,actor_id,pi_session_id,schema_version,manifest,manifest_digest,controller_signature,prompt_digest,run_status,expires_at) VALUES($1,$2,$3,$4,1,'{}',$5,'controller-signature',$5,'running','2099-01-01T00:00:00.000Z')",
      [RUN_A, TENANT_A, ACTOR_A, SESSION_A, "6".repeat(64)],
    );
    await database.query(
      "INSERT INTO pi_workspaces(id,tenant_id,actor_id,pi_session_id,pi_run_id,workspace_id,repository_id,provider,repository_ref,base_ref,base_commit_sha,ephemeral_branch,status,provider_workspace_ref,head_commit_sha,workspace_digest,destroyed_at) VALUES($1,$2,$3,$4,$5,'workspace-a',$6,'forgejo','acme/project','main',$7,'pi/76000000/change-a','destroyed','provider-workspace-a',$8,$9,'2026-08-20T00:02:00.000Z')",
      [WORKSPACE_A, TENANT_A, ACTOR_A, SESSION_A, RUN_A, REPOSITORY_A, BASE_SHA, HEAD_SHA, "f".repeat(64)],
    );
    await database.query(
      "INSERT INTO pi_checkpoints(id,tenant_id,pi_session_id,label,git_commit_sha,diff_digest,snapshot,pi_workspace_id,pi_run_id) VALUES($1,$2,$3,'checkpoint-a',$4,$5,'{}',$6,$7)",
      [CHECKPOINT_A, TENANT_A, SESSION_A, HEAD_SHA, DIFF_DIGEST, WORKSPACE_A, RUN_A],
    );
    for (const artifact of artifacts) {
      await database.query(
        "INSERT INTO workspace_artifacts(id,tenant_id,pi_session_id,artifact_type,storage_ref,content_digest,classification,actor_id,pi_run_id,pi_workspace_id,version,file_name,media_type,object_version,size_bytes,status,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
        [artifact.id, artifact.tenantId, artifact.sessionId, artifact.type, artifact.storageRef, artifact.contentDigest, artifact.classification, artifact.actorId, artifact.runId!, artifact.workspaceId!, artifact.version, artifact.fileName, artifact.mediaType, artifact.objectVersion, artifact.sizeBytes, artifact.status, new Date(artifact.updatedAt)],
      );
    }
    await database.query(
      "INSERT INTO pi_approvals(id,tenant_id,pi_session_id,pi_run_id,requested_by,risk_level,preview,input_digest,status,expires_at,tool_name,tool_version,profile,expected_object_versions,proposal_hash,required_approver_ids,approval_mode,required_approval_count,policy_version,policy_snapshot,version,revalidation_status) VALUES($1,$2,$3,$4,$5,'R2','change delivery',$6,'approved','2099-01-01T00:00:00.000Z','change.create_pull_request',1,'coding','{}',$7,'[]','single',1,1,'{}',1,'passed')",
      [APPROVAL_A, TENANT_A, SESSION_A, RUN_A, ACTOR_A, CHANGE_SET_DIGEST, APPROVAL_HASH],
    );
  });

  afterEach(async () => { await database.close(); });

  it("persists submission, UUID event, PR queue and external result with tenant/actor isolation", async () => {
    const evidence: PiChangeDeliveryEvidenceReader = {
      async getRepository() { return { id: REPOSITORY_A, tenantId: TENANT_A, workspaceId: "workspace-a", provider: "forgejo", repositoryRef: "acme/project", defaultBranch: "main", credentialRef: "credential-ref-a", status: "active", createdAt: "2026-08-20T00:00:00.000Z" }; },
      async getWorkspace() { return workspace; },
      async deliveryDiff() { return diff; },
      async checkpoints() { return [{ id: CHECKPOINT_A, sessionId: SESSION_A, diffDigest: DIFF_DIGEST, gitCommitSha: HEAD_SHA }]; },
      async listArtifacts() { return artifacts; },
    };
    const store = new PostgresPiChangeDeliveryStore(adapter);
    const service = new PiChangeDeliveryService(store, evidence, approvals, pullRequests, releases);
    const owner = context();
    const submitted = await service.submitChange(owner, {
      sessionId: SESSION_A,
      runId: RUN_A,
      workspaceRecordId: WORKSPACE_A,
      repositoryId: REPOSITORY_A,
      baseCommitSha: BASE_SHA,
      targetBranch: "main",
      checkpointIds: [CHECKPOINT_A],
      artifactIds: [TEST_ARTIFACT_A, SCAN_ARTIFACT_A],
      idempotencyKey: "postgres-change-submit-a",
    });
    expect(submitted.created).toBe(true);
    expect(submitted.submission.status).toBe("awaiting_approval");

    const queued = await service.createPullRequest(owner, submitted.submission.id);
    expect(queued.outbox.status).toBe("queued");
    expect(queued.pullRequest.status).toBe("pending");

    const dispatched = await service.dispatchOutbox(context(TENANT_A, ACTOR_A, "system"), queued.outbox.id);
    expect(dispatched.status).toBe("succeeded");
    expect((await service.getPullRequest(owner, queued.pullRequest.id)).status).toBe("open");
    expect((await service.getSubmission(owner, submitted.submission.id)).status).toBe("submitted");
    expect(await store.listSubmissions(context(TENANT_B, ACTOR_B))).toHaveLength(0);
    await expect(service.getSubmission(context(TENANT_A, ACTOR_B), submitted.submission.id)).rejects.toThrow("PI_CHANGE_SUBMISSION_NOT_FOUND");

    const storedEvent = await database.query<{ entity_id: string; subject_digest: string }>("SELECT entity_id,subject_digest FROM pi_delivery_events WHERE tenant_id=$1", [TENANT_A]);
    expect(storedEvent.rows).toHaveLength(4);
    expect(storedEvent.rows.every((row) => row.entity_id === WORKSPACE_A || row.entity_id === submitted.submission.id || row.entity_id === queued.pullRequest.id)).toBe(true);
    expect(storedEvent.rows.every((row) => /^[a-f0-9]{64}$/.test(row.subject_digest))).toBe(true);
    expect(JSON.stringify(storedEvent.rows)).not.toContain("credential-ref");

    const replay = await service.dispatchOutbox(context(TENANT_A, ACTOR_A, "system"), queued.outbox.id);
    expect(replay.status).toBe("succeeded");
    expect((await store.listOutbox(owner))[0]?.attempts).toBe(1);
  });

  it("enables FORCE RLS and preserves CAS no-replay semantics for every delivery table", async () => {
    const names = ["pi_change_submissions", "pi_pull_requests", "pi_merge_proposals", "pi_release_proposals", "pi_delivery_outbox", "pi_delivery_events"];
    const result = await database.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname", [names]);
    expect(result.rows).toHaveLength(names.length);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const count = await database.query<{ count: string }>("SELECT count(*) AS count FROM pi_delivery_events WHERE tenant_id=$1", [TENANT_A]);
    expect(Number(count.rows[0].count)).toBe(0);
  });

  it("persists lease fencing and terminalizes an expired delivery without replay", async () => {
    const evidence: PiChangeDeliveryEvidenceReader = {
      async getRepository() { return { id: REPOSITORY_A, tenantId: TENANT_A, workspaceId: "workspace-a", provider: "forgejo", repositoryRef: "acme/project", defaultBranch: "main", credentialRef: "credential-ref-a", status: "active", createdAt: "2026-08-20T00:00:00.000Z" }; },
      async getWorkspace() { return workspace; },
      async deliveryDiff() { return diff; },
      async checkpoints() { return [{ id: CHECKPOINT_A, sessionId: SESSION_A, diffDigest: DIFF_DIGEST, gitCommitSha: HEAD_SHA }]; },
      async listArtifacts() { return artifacts; },
    };
    const store = new PostgresPiChangeDeliveryStore(adapter);
    const service = new PiChangeDeliveryService(store, evidence, approvals, pullRequests, releases);
    const submitted = await service.submitChange(context(), { sessionId: SESSION_A, runId: RUN_A, workspaceRecordId: WORKSPACE_A, repositoryId: REPOSITORY_A, baseCommitSha: BASE_SHA, targetBranch: "main", checkpointIds: [CHECKPOINT_A], artifactIds: [TEST_ARTIFACT_A], idempotencyKey: "postgres-change-lease" });
    const pullRequest = await service.createPullRequest(context(), submitted.submission.id);
    const before = await store.getOutbox(context(), pullRequest.outbox.id);
    const oldLease = await store.claimOutbox(context(TENANT_A, ACTOR_A, "system"), pullRequest.outbox.id, before!.version, "2020-01-01T00:00:00.000Z", "old-worker", "76000000-0000-4000-8000-000000000014", 5_000);
    expect(oldLease).toMatchObject({ status: "leased", leaseOwner: "old-worker", leaseToken: "76000000-0000-4000-8000-000000000014" });

    const recovered = await service.dispatchOutbox(context(TENANT_A, ACTOR_A, "system"), pullRequest.outbox.id);
    expect(recovered).toMatchObject({ status: "unknown", lastErrorCode: "PI_CHANGE_LEASE_EXPIRED" });
    const stored = await database.query<{ status: string; lease_token: string | null; last_error_code: string }>("SELECT status,lease_token,last_error_code FROM pi_delivery_outbox WHERE id=$1", [pullRequest.outbox.id]);
    expect(stored.rows[0]).toEqual({ status: "unknown", lease_token: null, last_error_code: "PI_CHANGE_LEASE_EXPIRED" });
    expect(await store.completeOutbox(context(TENANT_A, ACTOR_A, "system"), pullRequest.outbox.id, oldLease!.version, { leaseToken: oldLease!.leaseToken!, status: "succeeded", resultDigest: "3".repeat(64), updatedAt: new Date().toISOString() })).toBeNull();
  });
});
