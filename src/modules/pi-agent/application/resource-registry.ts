import { createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { sha256 } from "@/src/modules/pi-agent/application/manifest";
import type {
  PiArtifactResourceRelease,
  PiApprovedSkill,
  PiResourceApprovalStatus,
  PiResourceKind,
  PiResourceRegistryDependencies,
  PiResourceResolveInput,
  PiResourceSnapshot,
  PiResourceSignatureVerifier,
  PiSkillCatalogItem,
  PiSkillRelease,
} from "@/src/modules/pi-agent/domain/resource-contracts";
import type { PiResourceRegistryStore } from "@/src/modules/pi-agent/domain/resource-contracts";
import type { PiProfileId } from "@/src/modules/pi-agent/domain/contracts";

export function canonicalPiResourcePayload(input: { kind: PiResourceKind; resourceId: string; version: string; digest: string }): string {
  return `nexus-pi-resource-v1\n${input.kind}\n${input.resourceId}\n${input.version}\n${input.digest}`;
}

function assertDigest(value: string, code = "PI_RESOURCE_DIGEST_INVALID"): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(code);
}

function assertRollout(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("PI_RESOURCE_ROLLOUT_INVALID");
}

function isAllowedProfile(allowedProfiles: PiProfileId[], profile: PiProfileId): boolean {
  return allowedProfiles.includes(profile) || allowedProfiles.includes("*" as PiProfileId);
}

function assertResourceResolutionPermission(context: RequestContext): void {
  if (context.channel === "system" || context.permissions.includes("pi:registry:read") || context.permissions.includes("pi:catalog:read")) return;
  throw new Error("POLICY_DENIED:pi:registry:read");
}

function rolloutBucket(actorId: string, digest: string): number {
  return Number.parseInt(sha256(`${actorId}:${digest}`).slice(0, 8), 16) % 100;
}

function latestById<T extends { resourceId?: string; skillId?: string; version: string; createdAt: string }>(releases: T[]): T[] {
  const selected = new Map<string, T>();
  for (const release of [...releases].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    const id = "resourceId" in release ? String(release.resourceId) : String(release.skillId);
    if (!selected.has(id)) selected.set(id, release);
  }
  return [...selected.values()];
}

function parseSkillMetadata(skillId: string, content: string): { name: string; description: string } {
  const name = /^name:\s*(.+)$/mi.exec(content)?.[1]?.trim() || skillId;
  const description = /^description:\s*(.+)$/mi.exec(content)?.[1]?.trim() || `Approved enterprise skill ${skillId}`;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error("PI_SKILL_MANIFEST_INVALID");
  if (description.length > 1_000) throw new Error("PI_SKILL_MANIFEST_INVALID");
  return { name, description };
}

export class Ed25519PiResourceSignatureVerifier implements PiResourceSignatureVerifier {
  private readonly key: ReturnType<typeof createPublicKey>;

  constructor(publicKeyPem: string) {
    this.key = createPublicKey(publicKeyPem);
  }

  async verify(input: { kind: PiResourceKind; resourceId: string; version: string; digest: string; signature: string }): Promise<boolean> {
    try {
      const signature = Buffer.from(input.signature, "base64url");
      return verifySignature(null, Buffer.from(canonicalPiResourcePayload(input)), this.key, signature);
    } catch {
      return false;
    }
  }
}

export class FailClosedPiResourceSignatureVerifier implements PiResourceSignatureVerifier {
  async verify(): Promise<boolean> { return false; }
}

export class PiResourceRegistryService {
  private readonly registryVersion: string;

  constructor(private readonly dependencies: PiResourceRegistryDependencies) {
    this.registryVersion = dependencies.registryVersion ?? "registry-v1";
  }

  async publishSkillDraft(context: RequestContext, input: {
    skillId: string;
    version: string;
    scope: PiSkillRelease["scope"];
    signature: string;
    content: string;
    requiredTools: string[];
    dataClassification: PiSkillRelease["dataClassification"];
    riskLevel: PiSkillRelease["riskLevel"];
    allowedProfiles: PiProfileId[];
  }): Promise<PiSkillRelease> {
    assertPiPermission(context, "pi:registry:write");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.skillId) || !/^[A-Za-z0-9._-]{1,64}$/.test(input.version) || !input.content.trim()) throw new Error("PI_SKILL_MANIFEST_INVALID");
    const digest = sha256(input.content);
    const metadata = parseSkillMetadata(input.skillId, input.content);
    void metadata;
    const release: PiSkillRelease = {
      id: randomUUID(), tenantId: context.tenantId, skillId: input.skillId, version: input.version, scope: input.scope, digest,
      signature: input.signature, content: input.content, requiredTools: [...new Set(input.requiredTools)].sort(), dataClassification: input.dataClassification,
      riskLevel: input.riskLevel, allowedProfiles: [...new Set(input.allowedProfiles)], approvalStatus: "pending", rolloutPercent: 0, createdAt: new Date().toISOString(),
    };
    await this.dependencies.store.putSkillRelease(release);
    return release;
  }

  async publishArtifactDraft(context: RequestContext, input: {
    resourceId: string;
    kind: "package" | "extension";
    version: string;
    digest: string;
    signature: string;
    artifactRef: string;
    sbomDigest: string;
    allowedProfiles: PiProfileId[];
    dataClassification: PiArtifactResourceRelease["dataClassification"];
    riskLevel: PiArtifactResourceRelease["riskLevel"];
  }): Promise<PiArtifactResourceRelease> {
    assertPiPermission(context, "pi:registry:write");
    assertDigest(input.digest);
    assertDigest(input.sbomDigest, "PI_RESOURCE_SBOM_DIGEST_INVALID");
    if (!/^[A-Za-z0-9._/-]{1,256}$/.test(input.resourceId) || !/^[A-Za-z0-9._-]{1,64}$/.test(input.version) || !input.artifactRef.trim()) throw new Error("PI_RESOURCE_MANIFEST_INVALID");
    const release: PiArtifactResourceRelease = {
      id: randomUUID(), tenantId: context.tenantId, resourceId: input.resourceId, kind: input.kind, version: input.version, digest: input.digest.toLowerCase(),
      signature: input.signature, artifactRef: input.artifactRef, sbomDigest: input.sbomDigest.toLowerCase(), scanStatus: "pending", approvalStatus: "pending",
      rolloutPercent: 0, allowedProfiles: [...new Set(input.allowedProfiles)], dataClassification: input.dataClassification, riskLevel: input.riskLevel, createdAt: new Date().toISOString(),
    };
    await this.dependencies.store.putArtifactResourceRelease(release);
    return release;
  }

  async recordScanResult(context: RequestContext, input: { kind: "package" | "extension"; resourceId: string; version: string; status: "passed" | "failed" }): Promise<PiArtifactResourceRelease> {
    assertPiPermission(context, "pi:registry:scan");
    return this.dependencies.store.updateArtifactResourceRelease(context, input.kind, input.resourceId, input.version, { scanStatus: input.status });
  }

  async validateManifest(context: RequestContext, input: { kind: PiResourceKind; resourceId: string; version: string }): Promise<{ valid: boolean; digest?: string }> {
    assertPiPermission(context, "pi:registry:read");
    if (input.kind === "skill") {
      const release = await this.dependencies.store.getSkillRelease(context, input.resourceId, input.version);
      if (!release) throw new Error("PI_RESOURCE_RELEASE_NOT_FOUND");
      const validSignature = await this.dependencies.verifier.verify({ kind: input.kind, resourceId: input.resourceId, version: input.version, digest: release.digest, signature: release.signature });
      if (!validSignature) throw new Error("PI_RESOURCE_SIGNATURE_INVALID");
      if (release.content !== undefined && sha256(release.content) !== release.digest) throw new Error("PI_RESOURCE_DIGEST_MISMATCH");
      return { valid: true, digest: release.digest };
    }
    const release = await this.dependencies.store.getArtifactResourceRelease(context, input.kind, input.resourceId, input.version);
    if (!release) throw new Error("PI_RESOURCE_RELEASE_NOT_FOUND");
    const validSignature = await this.dependencies.verifier.verify({ kind: input.kind, resourceId: input.resourceId, version: input.version, digest: release.digest, signature: release.signature });
    if (!validSignature) throw new Error("PI_RESOURCE_SIGNATURE_INVALID");
    return { valid: true, digest: release.digest };
  }

  async approve(context: RequestContext, input: { kind: PiResourceKind; resourceId: string; version: string }): Promise<PiSkillRelease | PiArtifactResourceRelease> {
    assertPiPermission(context, "pi:registry:approve");
    await this.validateManifest(context, input);
    const now = new Date().toISOString();
    if (input.kind === "skill") return this.dependencies.store.updateSkillRelease(context, input.resourceId, input.version, { approvalStatus: "approved", rolloutPercent: 0, approvedAt: now, revokedAt: undefined });
    const release = await this.dependencies.store.getArtifactResourceRelease(context, input.kind, input.resourceId, input.version);
    if (!release || release.scanStatus !== "passed") throw new Error("PI_RESOURCE_SCAN_REQUIRED");
    return this.dependencies.store.updateArtifactResourceRelease(context, input.kind, input.resourceId, input.version, { approvalStatus: "approved", rolloutPercent: 0, approvedAt: now, revokedAt: undefined });
  }

  async rollout(context: RequestContext, input: { kind: PiResourceKind; resourceId: string; version: string; percent: number }): Promise<PiSkillRelease | PiArtifactResourceRelease> {
    assertPiPermission(context, "pi:registry:approve");
    assertRollout(input.percent);
    if (input.kind === "skill") {
      const current = await this.requireSkill(context, input.resourceId, input.version);
      if (current.approvalStatus !== "approved") throw new Error("PI_RESOURCE_NOT_APPROVED");
      return this.dependencies.store.updateSkillRelease(context, input.resourceId, input.version, { rolloutPercent: input.percent });
    }
    const current = await this.requireArtifact(context, input.kind, input.resourceId, input.version);
    if (current.approvalStatus !== "approved" || current.scanStatus !== "passed") throw new Error("PI_RESOURCE_NOT_APPROVED");
    return this.dependencies.store.updateArtifactResourceRelease(context, input.kind, input.resourceId, input.version, { rolloutPercent: input.percent });
  }

  async revoke(context: RequestContext, input: { kind: PiResourceKind; resourceId: string; version: string }): Promise<PiSkillRelease | PiArtifactResourceRelease> {
    assertPiPermission(context, "pi:registry:approve");
    const now = new Date().toISOString();
    if (input.kind === "skill") return this.dependencies.store.updateSkillRelease(context, input.resourceId, input.version, { approvalStatus: "revoked", rolloutPercent: 0, revokedAt: now });
    return this.dependencies.store.updateArtifactResourceRelease(context, input.kind, input.resourceId, input.version, { approvalStatus: "revoked", rolloutPercent: 0, revokedAt: now });
  }

  async resolveSkillSet(context: RequestContext, input: PiResourceResolveInput): Promise<import("@/src/modules/pi-agent/domain/resource-contracts").PiResolvedResourceSet> {
    assertResourceResolutionPermission(context);
    const skills = await this.resolveSkills(context, input);
    const packages = await this.resolveArtifacts(context, "package", input.packageIds, input);
    const extensions = await this.resolveArtifacts(context, "extension", input.extensionIds, input);
    const snapshot: PiResourceSnapshot = {
      schemaVersion: 1,
      skillDigests: skills.map((item) => item.release.digest).sort(),
      packageDigests: packages.map((item) => item.digest).sort(),
      extensionDigests: extensions.map((item) => item.digest).sort(),
      policyVersion: input.policyVersion,
      registryVersion: this.registryVersion,
      resolvedAt: new Date().toISOString(),
    };
    return { snapshot, skills, packages, extensions };
  }

  async listSkillCatalog(context: RequestContext, input: { profile: PiProfileId; availableTools: string[] }): Promise<PiSkillCatalogItem[]> {
    assertResourceResolutionPermission(context);
    const candidates = latestById(await this.dependencies.store.listSkillReleases(context)).filter((release) => this.approvedFor(context, release, {
      profile: input.profile,
      availableTools: input.availableTools,
      policyVersion: 1,
    }));
    const result: PiSkillCatalogItem[] = [];
    for (const release of candidates) {
      await this.verifyApprovedSkill(release, { profile: input.profile, availableTools: input.availableTools, policyVersion: 1 });
      result.push({
        skillId: release.skillId,
        version: release.version,
        scope: release.scope,
        digest: release.digest,
        requiredTools: [...release.requiredTools],
        dataClassification: release.dataClassification,
        riskLevel: release.riskLevel,
        allowedProfiles: [...release.allowedProfiles],
        approvalStatus: release.approvalStatus,
        rolloutPercent: release.rolloutPercent,
        createdAt: release.createdAt,
      });
    }
    return result;
  }

  async listAdminResources(context: RequestContext): Promise<{
    skills: Array<Omit<PiSkillRelease, "tenantId" | "signature" | "content" | "contentRef">>;
    artifacts: Array<Omit<PiArtifactResourceRelease, "tenantId" | "signature" | "artifactRef" | "sbomDigest">>;
  }> {
    assertPiPermission(context, "pi:registry:read");
    const [skills, artifacts] = await Promise.all([
      this.dependencies.store.listSkillReleases(context),
      this.dependencies.store.listArtifactResourceReleases(context),
    ]);
    return {
      skills: skills.map(({ tenantId, signature, content, contentRef, ...safe }) => {
        void tenantId;
        void signature;
        void content;
        void contentRef;
        return safe;
      }),
      artifacts: artifacts.map(({ tenantId, signature, artifactRef, sbomDigest, ...safe }) => {
        void tenantId;
        void signature;
        void artifactRef;
        void sbomDigest;
        return safe;
      }),
    };
  }

  async loadSnapshot(context: RequestContext, snapshot: PiResourceSnapshot, input: { profile: PiProfileId; availableTools: string[] }): Promise<import("@/src/modules/pi-agent/domain/resource-contracts").PiResolvedResourceSet> {
    assertResourceResolutionPermission(context);
    if (snapshot.schemaVersion !== 1 || snapshot.registryVersion !== this.registryVersion) throw new Error("PI_RESOURCE_SNAPSHOT_VERSION_INVALID");
    for (const digest of [...snapshot.skillDigests, ...snapshot.packageDigests, ...snapshot.extensionDigests]) assertDigest(digest, "PI_RESOURCE_SNAPSHOT_DIGEST_INVALID");
    const allSkills = await this.dependencies.store.listSkillReleases(context);
    const allArtifacts = await this.dependencies.store.listArtifactResourceReleases(context);
    const skills = await this.snapshotSkills(context, snapshot.skillDigests, allSkills, input);
    const packages = await this.snapshotArtifacts(context, snapshot.packageDigests, allArtifacts.filter((item) => item.kind === "package"), input);
    const extensions = await this.snapshotArtifacts(context, snapshot.extensionDigests, allArtifacts.filter((item) => item.kind === "extension"), input);
    return { snapshot, skills, packages, extensions };
  }

  private async resolveSkills(context: RequestContext, input: PiResourceResolveInput): Promise<PiApprovedSkill[]> {
    const candidates = latestById(await this.dependencies.store.listSkillReleases(context)).filter((release) => this.approvedFor(context, release, input));
    const requested = new Set(input.skillIds ?? []);
    const selected = candidates.filter((release) => requested.size === 0 || requested.has(release.skillId));
    for (const id of requested) if (!selected.some((release) => release.skillId === id)) throw new Error("PI_SKILL_NOT_AVAILABLE");
    const result: PiApprovedSkill[] = [];
    for (const release of selected) {
      await this.verifyApprovedSkill(release, input);
      const content = release.content;
      if (!content) throw new Error("PI_SKILL_CONTENT_UNAVAILABLE");
      const metadata = parseSkillMetadata(release.skillId, content);
      result.push({ release, name: metadata.name, description: metadata.description, content });
    }
    return result;
  }

  private async resolveArtifacts(context: RequestContext, kind: "package" | "extension", requestedIds: string[] | undefined, input: PiResourceResolveInput): Promise<PiArtifactResourceRelease[]> {
    const candidates = latestById(await this.dependencies.store.listArtifactResourceReleases(context, kind)).filter((release) => this.approvedFor(context, release, input) && release.scanStatus === "passed");
    const requested = new Set(requestedIds ?? []);
    const selected = candidates.filter((release) => requested.size === 0 || requested.has(release.resourceId));
    for (const id of requested) if (!selected.some((release) => release.resourceId === id)) throw new Error("PI_RESOURCE_NOT_AVAILABLE");
    for (const release of selected) {
      const valid = await this.dependencies.verifier.verify({ kind, resourceId: release.resourceId, version: release.version, digest: release.digest, signature: release.signature });
      if (!valid) throw new Error("PI_RESOURCE_SIGNATURE_INVALID");
    }
    return selected;
  }

  private approvedFor(context: RequestContext, release: { approvalStatus: PiResourceApprovalStatus; rolloutPercent: number; allowedProfiles: PiProfileId[]; requiredTools?: string[]; digest: string }, input: PiResourceResolveInput): boolean {
    return release.approvalStatus === "approved" && release.rolloutPercent > rolloutBucket(context.actorId, release.digest) && isAllowedProfile(release.allowedProfiles, input.profile) && (!release.requiredTools || release.requiredTools.every((tool) => input.availableTools.includes(tool)));
  }

  private async verifyApprovedSkill(release: PiSkillRelease, input: PiResourceResolveInput): Promise<void> {
    const valid = await this.dependencies.verifier.verify({ kind: "skill", resourceId: release.skillId, version: release.version, digest: release.digest, signature: release.signature });
    if (!valid) throw new Error("PI_RESOURCE_SIGNATURE_INVALID");
    if (!release.content || sha256(release.content) !== release.digest) throw new Error("PI_RESOURCE_DIGEST_MISMATCH");
    if (release.requiredTools.some((tool) => !input.availableTools.includes(tool))) throw new Error("PI_RESOURCE_TOOL_NOT_ALLOWED");
  }

  private async snapshotSkills(_context: RequestContext, digests: string[], releases: PiSkillRelease[], input: { profile: PiProfileId; availableTools: string[] }): Promise<PiApprovedSkill[]> {
    const result: PiApprovedSkill[] = [];
    for (const digest of digests) {
      const release = releases.find((item) => item.digest === digest);
      if (!release || release.approvalStatus !== "approved") throw new Error("PI_RESOURCE_SNAPSHOT_REVOKED");
      if (!isAllowedProfile(release.allowedProfiles, input.profile)) throw new Error("PI_RESOURCE_PROFILE_NOT_ALLOWED");
      await this.verifyApprovedSkill(release, { ...input, policyVersion: 1, skillIds: [] });
      const metadata = parseSkillMetadata(release.skillId, release.content!);
      result.push({ release, name: metadata.name, description: metadata.description, content: release.content! });
    }
    return result;
  }

  private async snapshotArtifacts(_context: RequestContext, digests: string[], releases: PiArtifactResourceRelease[], input: { profile: PiProfileId; availableTools: string[] }): Promise<PiArtifactResourceRelease[]> {
    const result: PiArtifactResourceRelease[] = [];
    for (const digest of digests) {
      const release = releases.find((item) => item.digest === digest);
      if (!release || release.approvalStatus !== "approved" || release.scanStatus !== "passed") throw new Error("PI_RESOURCE_SNAPSHOT_REVOKED");
      if (!isAllowedProfile(release.allowedProfiles, input.profile)) throw new Error("PI_RESOURCE_PROFILE_NOT_ALLOWED");
      const valid = await this.dependencies.verifier.verify({ kind: release.kind, resourceId: release.resourceId, version: release.version, digest: release.digest, signature: release.signature });
      if (!valid) throw new Error("PI_RESOURCE_SIGNATURE_INVALID");
      result.push(release);
    }
    return result;
  }

  private async requireSkill(context: RequestContext, skillId: string, version: string): Promise<PiSkillRelease> {
    const release = await this.dependencies.store.getSkillRelease(context, skillId, version);
    if (!release) throw new Error("PI_SKILL_RELEASE_NOT_FOUND");
    return release;
  }

  private async requireArtifact(context: RequestContext, kind: "package" | "extension", resourceId: string, version: string): Promise<PiArtifactResourceRelease> {
    const release = await this.dependencies.store.getArtifactResourceRelease(context, kind, resourceId, version);
    if (!release) throw new Error("PI_RESOURCE_RELEASE_NOT_FOUND");
    return release;
  }
}

export function createPiResourceRegistry(store: PiResourceRegistryStore): PiResourceRegistryService {
  const publicKey = process.env.NEXUS_PI_RESOURCE_PUBLIC_KEY;
  if (!publicKey) return new PiResourceRegistryService({ store, verifier: new FailClosedPiResourceSignatureVerifier() });
  try {
    return new PiResourceRegistryService({ store, verifier: new Ed25519PiResourceSignatureVerifier(publicKey) });
  } catch {
    return new PiResourceRegistryService({ store, verifier: new FailClosedPiResourceSignatureVerifier() });
  }
}
