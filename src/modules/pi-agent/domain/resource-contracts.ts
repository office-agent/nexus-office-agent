import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiProfileId } from "@/src/modules/pi-agent/domain/contracts";

export type PiResourceKind = "skill" | "package" | "extension";
export type PiResourceScope = "global" | "tenant" | "project" | "personal";
export type PiResourceApprovalStatus = "pending" | "approved" | "revoked";
export type PiResourceScanStatus = "not_required" | "pending" | "passed" | "failed";
export type PiResourceClassification = "public" | "internal" | "confidential" | "restricted";
export type PiResourceRiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";

export type PiSkillRelease = {
  id: string;
  tenantId: string;
  skillId: string;
  version: string;
  scope: PiResourceScope;
  digest: string;
  signature: string;
  contentRef?: string;
  content?: string;
  requiredTools: string[];
  dataClassification: PiResourceClassification;
  riskLevel: PiResourceRiskLevel;
  allowedProfiles: PiProfileId[];
  approvalStatus: PiResourceApprovalStatus;
  rolloutPercent: number;
  createdAt: string;
  approvedAt?: string;
  revokedAt?: string;
};

export type PiArtifactResourceRelease = {
  id: string;
  tenantId: string;
  resourceId: string;
  kind: "package" | "extension";
  version: string;
  digest: string;
  signature: string;
  artifactRef: string;
  sbomDigest: string;
  scanStatus: PiResourceScanStatus;
  approvalStatus: PiResourceApprovalStatus;
  rolloutPercent: number;
  allowedProfiles: PiProfileId[];
  dataClassification: PiResourceClassification;
  riskLevel: PiResourceRiskLevel;
  createdAt: string;
  approvedAt?: string;
  revokedAt?: string;
};

export type PiResourceSnapshot = {
  schemaVersion: 1;
  skillDigests: string[];
  packageDigests: string[];
  extensionDigests: string[];
  policyVersion: number;
  registryVersion: string;
  resolvedAt: string;
};

export type PiApprovedSkill = {
  release: PiSkillRelease;
  name: string;
  description: string;
  content: string;
};

export type PiSkillCatalogItem = {
  skillId: string;
  version: string;
  scope: PiResourceScope;
  digest: string;
  requiredTools: string[];
  dataClassification: PiResourceClassification;
  riskLevel: PiResourceRiskLevel;
  allowedProfiles: PiProfileId[];
  approvalStatus: PiResourceApprovalStatus;
  rolloutPercent: number;
  createdAt: string;
};

export type PiResolvedResourceSet = {
  snapshot: PiResourceSnapshot;
  skills: PiApprovedSkill[];
  packages: PiArtifactResourceRelease[];
  extensions: PiArtifactResourceRelease[];
};

export type PiResourceResolveInput = {
  profile: PiProfileId;
  availableTools: string[];
  skillIds?: string[];
  packageIds?: string[];
  extensionIds?: string[];
  policyVersion: number;
};

export interface PiResourceRegistryStore {
  putSkillRelease(release: PiSkillRelease): Promise<void>;
  getSkillRelease(context: RequestContext, skillId: string, version?: string): Promise<PiSkillRelease | null>;
  listSkillReleases(context: RequestContext): Promise<PiSkillRelease[]>;
  updateSkillRelease(context: RequestContext, skillId: string, version: string, patch: Partial<Pick<PiSkillRelease, "approvalStatus" | "rolloutPercent" | "approvedAt" | "revokedAt">>): Promise<PiSkillRelease>;
  putArtifactResourceRelease(release: PiArtifactResourceRelease): Promise<void>;
  getArtifactResourceRelease(context: RequestContext, kind: "package" | "extension", resourceId: string, version?: string): Promise<PiArtifactResourceRelease | null>;
  listArtifactResourceReleases(context: RequestContext, kind?: "package" | "extension"): Promise<PiArtifactResourceRelease[]>;
  updateArtifactResourceRelease(context: RequestContext, kind: "package" | "extension", resourceId: string, version: string, patch: Partial<Pick<PiArtifactResourceRelease, "approvalStatus" | "rolloutPercent" | "approvedAt" | "revokedAt" | "scanStatus">>): Promise<PiArtifactResourceRelease>;
}

export interface PiResourceSignatureVerifier {
  verify(input: { kind: PiResourceKind; resourceId: string; version: string; digest: string; signature: string }): Promise<boolean>;
}

export type PiResourceRegistryDependencies = {
  store: PiResourceRegistryStore;
  verifier: PiResourceSignatureVerifier;
  registryVersion?: string;
};
