// Requirements: PR-010, SR-005, SR-006, AC-011, AC-012, DR-010
import { generateKeyPairSync, sign as signSignature, type KeyObject } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import type { RequestContext } from "@/src/platform/context/request-context";
import { sha256 } from "@/src/modules/pi-agent/application/manifest";
import { canonicalPiResourcePayload, Ed25519PiResourceSignatureVerifier, PiResourceRegistryService } from "@/src/modules/pi-agent/application/resource-registry";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PostgresPiResourceRegistryStore } from "@/src/modules/pi-agent/infrastructure/resource-store";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";

const TENANT_A = "50000000-0000-4000-8000-000000000001";
const ACTOR_A = "50000000-0000-4000-8000-000000000002";
const TENANT_B = "50000000-0000-4000-8000-000000000011";
const ACTOR_B = "50000000-0000-4000-8000-000000000012";

const context = (tenantId = TENANT_A, actorId = ACTOR_A): RequestContext => ({
  tenantId,
  actorId,
  sessionId: "postgres-resource-session",
  channel: "web",
  traceId: `postgres-resource-trace-${tenantId}`,
  roles: [],
  permissions: [
    "pi:registry:read",
    "pi:registry:write",
    "pi:registry:approve",
    "pi:registry:scan",
    "pi:session:create",
    "pi:session:read",
    "pi:session:write",
    "pi:workspace:read",
    "pi:workspace:write",
    "pi:sandbox:execute",
  ],
  dataScopes: [{ type: "tenant" }],
});

function signature(privateKey: KeyObject, input: { kind: "skill" | "package"; resourceId: string; version: string; digest: string }): string {
  return signSignature(null, Buffer.from(canonicalPiResourcePayload(input)), privateKey).toString("base64url");
}

describe("PostgreSQL Pi resource registry", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const directory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) await database.exec(await readFile(path.join(directory, file), "utf8"));
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
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'resource-a','Resource A','active'),($2,'resource-b','Resource B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Resource A','resource-a@example.test','active'),($3,$4,'Resource B','resource-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("persists signed Skill releases, applies approval/rollout, and stores the exact snapshot in a Postgres Session", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const store = new PostgresPiResourceRegistryStore(adapter);
    const registry = new PiResourceRegistryService({
      store,
      verifier: new Ed25519PiResourceSignatureVerifier(publicKey.export({ type: "spki", format: "pem" }).toString()),
      registryVersion: "registry-postgres-v1",
    });
    const content = "---\nname: postgres-skill\ndescription: Postgres governed skill\n---\nUse the approved workspace tools.";
    const digest = sha256(content);
    const admin = context();
    const release = await registry.publishSkillDraft(admin, {
      skillId: "postgres-skill",
      version: "1.0.0",
      scope: "tenant",
      signature: signature(privateKey, { kind: "skill", resourceId: "postgres-skill", version: "1.0.0", digest }),
      content,
      requiredTools: ["workspace_read"],
      dataClassification: "internal",
      riskLevel: "R1",
      allowedProfiles: ["coding"],
    });
    expect(await store.getSkillRelease(context(TENANT_B, ACTOR_B), release.skillId, release.version)).toBeNull();
    await registry.approve(admin, { kind: "skill", resourceId: release.skillId, version: release.version });
    await registry.rollout(admin, { kind: "skill", resourceId: release.skillId, version: release.version, percent: 100 });

    const resolved = await registry.resolveSkillSet(admin, { profile: "coding", availableTools: ["workspace_read"], skillIds: [release.skillId], policyVersion: 7 });
    expect(resolved.snapshot).toMatchObject({ schemaVersion: 1, registryVersion: "registry-postgres-v1", policyVersion: 7, skillDigests: [digest] });
    const rows = await database.query<{ approval_status: string; rollout_percent: number; content: string }>("SELECT approval_status, rollout_percent, content FROM skill_releases WHERE tenant_id=$1 AND skill_id=$2", [TENANT_A, release.skillId]);
    expect(rows.rows[0]).toMatchObject({ approval_status: "approved", rollout_percent: 100, content });

    const sessions = new PostgresPiSessionStore(adapter);
    const runs = new PostgresPiRunStore(adapter);
    const agent = new PiAgentService(sessions, new VirtualSandboxProvider(), runs, registry);
    const session = await agent.createSession(admin, { profile: "coding", workspaceId: "workspace-postgres", skillIds: [release.skillId] });
    expect(session.resourceSnapshot).toMatchObject({ registryVersion: "registry-postgres-v1", policyVersion: 1, skillDigests: [digest] });
    const stored = await sessions.getSession(admin, session.id);
    expect(stored?.resourceSnapshot).toMatchObject({ registryVersion: "registry-postgres-v1", skillDigests: [digest] });
    const accepted = await agent.sendMessage(admin, session.id, "检查资源快照", "postgres-resource-run-1");
    expect((await runs.getManifest(admin, accepted.runId))?.resourceSnapshot).toMatchObject({ schemaVersion: 1, registryVersion: "registry-postgres-v1", skillDigests: [digest] });
    await expect(registry.resolveSkillSet(context(TENANT_B, ACTOR_B), { profile: "coding", availableTools: ["workspace_read"], skillIds: [release.skillId], policyVersion: 1 })).rejects.toThrow("PI_SKILL_NOT_AVAILABLE");

    await registry.revoke(admin, { kind: "skill", resourceId: release.skillId, version: release.version });
    expect((await database.query<{ revoked_at: string | null }>("SELECT revoked_at FROM skill_releases WHERE tenant_id=$1 AND skill_id=$2", [TENANT_A, release.skillId])).rows[0].revoked_at).not.toBeNull();
    await registry.approve(admin, { kind: "skill", resourceId: release.skillId, version: release.version });
    expect((await database.query<{ revoked_at: string | null }>("SELECT revoked_at FROM skill_releases WHERE tenant_id=$1 AND skill_id=$2", [TENANT_A, release.skillId])).rows[0].revoked_at).toBeNull();
  });

  it("keeps OCI Package approval behind the scan status and isolates the artifact table by tenant", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const store = new PostgresPiResourceRegistryStore(adapter);
    const registry = new PiResourceRegistryService({
      store,
      verifier: new Ed25519PiResourceSignatureVerifier(publicKey.export({ type: "spki", format: "pem" }).toString()),
      registryVersion: "registry-postgres-v1",
    });
    const admin = context();
    const digest = sha256("postgres-package-bytes");
    const sbomDigest = sha256("postgres-package-sbom");
    const release = await registry.publishArtifactDraft(admin, {
      resourceId: "postgres-package",
      kind: "package",
      version: "1.0.0",
      digest,
      signature: signature(privateKey, { kind: "package", resourceId: "postgres-package", version: "1.0.0", digest }),
      artifactRef: `oci://registry.internal/pi/postgres-package@sha256:${digest}`,
      sbomDigest,
      allowedProfiles: ["coding"],
      dataClassification: "internal",
      riskLevel: "R1",
    });
    expect(await store.getArtifactResourceRelease(context(TENANT_B, ACTOR_B), "package", release.resourceId, release.version)).toBeNull();
    await expect(registry.approve(admin, { kind: "package", resourceId: release.resourceId, version: release.version })).rejects.toThrow("PI_RESOURCE_SCAN_REQUIRED");
    await registry.recordScanResult(admin, { kind: "package", resourceId: release.resourceId, version: release.version, status: "passed" });
    await registry.approve(admin, { kind: "package", resourceId: release.resourceId, version: release.version });
    await registry.rollout(admin, { kind: "package", resourceId: release.resourceId, version: release.version, percent: 100 });
    const resolved = await registry.resolveSkillSet(admin, { profile: "coding", availableTools: [], packageIds: [release.resourceId], policyVersion: 1 });
    expect(resolved.packages[0]).toMatchObject({ digest, sbomDigest, scanStatus: "passed", approvalStatus: "approved" });
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_resource_releases WHERE tenant_id=$1", [TENANT_A])).rows[0].count).toBe(1);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_resource_releases WHERE tenant_id=$1", [TENANT_B])).rows[0].count).toBe(0);

    await registry.revoke(admin, { kind: "package", resourceId: release.resourceId, version: release.version });
    expect((await database.query<{ revoked_at: string | null }>("SELECT revoked_at FROM pi_resource_releases WHERE tenant_id=$1 AND resource_id=$2", [TENANT_A, release.resourceId])).rows[0].revoked_at).not.toBeNull();
    await registry.approve(admin, { kind: "package", resourceId: release.resourceId, version: release.version });
    expect((await database.query<{ revoked_at: string | null }>("SELECT revoked_at FROM pi_resource_releases WHERE tenant_id=$1 AND resource_id=$2", [TENANT_A, release.resourceId])).rows[0].revoked_at).toBeNull();
  });
});
