import type { RequestContext } from "@/src/platform/context/request-context";

export type PiReleaseStatus = "candidate" | "staged" | "active" | "rolled_back";
export type PiReadinessStatus = "pass" | "fail" | "warning";
export type PiReadinessCategory = "artifact" | "dependency" | "security" | "operations" | "recovery";

export type PiReleaseCandidate = {
  id: string;
  tenantId: string;
  createdBy: string;
  version: string;
  imageDigest: string;
  manifestDigest: string;
  signatureDigest: string;
  sbomDigest?: string;
  actionDigest: string;
  status: PiReleaseStatus;
  createdAt: string;
  activatedAt?: string;
  rolledBackAt?: string;
};

export type PiReadinessCheck = {
  id: string;
  category: PiReadinessCategory;
  status: PiReadinessStatus;
  message: string;
  evidenceDigest?: string;
};

export type PiReadinessSnapshot = {
  id: string;
  tenantId: string;
  actorId: string;
  releaseId: string;
  ready: boolean;
  checks: PiReadinessCheck[];
  policyVersion: number;
  generatedAt: string;
  failureDigest?: string;
};

export type PiSecretLeaseStatus = "active" | "revoked";

export type PiSecretLease = {
  id: string;
  tenantId: string;
  actorId: string;
  purpose: string;
  audience: string;
  referenceDigest: string;
  status: PiSecretLeaseStatus;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokeActorId?: string;
};

export type PiPreproductionEventKind =
  | "pi.preproduction.readiness_evaluated"
  | "pi.release.promoted"
  | "pi.release.rolled_back"
  | "pi.secret.lease_issued"
  | "pi.secret.lease_revoked";

export type PiPreproductionEvent = {
  id: string;
  tenantId: string;
  actorId: string;
  kind: PiPreproductionEventKind;
  subjectDigest: string;
  traceId: string;
  createdAt: string;
};

export type PiPreproductionSnapshot = {
  releases: PiReleaseCandidate[];
  readiness: PiReadinessSnapshot[];
  secretLeases: PiSecretLease[];
  events: PiPreproductionEvent[];
  generatedAt: string;
};

export interface PiPreproductionStore {
  putRelease(release: PiReleaseCandidate): Promise<{ release: PiReleaseCandidate; created: boolean }>;
  findRelease(context: RequestContext, id: string): Promise<PiReleaseCandidate | null>;
  findReleaseByActionDigest(context: RequestContext, actionDigest: string): Promise<PiReleaseCandidate | null>;
  listReleases(context: RequestContext): Promise<PiReleaseCandidate[]>;
  promoteRelease(context: RequestContext, id: string, activatedAt: string): Promise<PiReleaseCandidate>;
  rollbackRelease(context: RequestContext, id: string, rolledBackAt: string): Promise<PiReleaseCandidate>;
  putReadiness(snapshot: PiReadinessSnapshot): Promise<void>;
  latestReadiness(context: RequestContext, releaseId: string): Promise<PiReadinessSnapshot | null>;
  listReadiness(context: RequestContext, limit?: number): Promise<PiReadinessSnapshot[]>;
  putSecretLease(lease: PiSecretLease): Promise<void>;
  findSecretLease(context: RequestContext, id: string): Promise<PiSecretLease | null>;
  listSecretLeases(context: RequestContext): Promise<PiSecretLease[]>;
  revokeSecretLease(context: RequestContext, id: string, revokedAt: string, actorId: string): Promise<PiSecretLease>;
  appendEvent(event: PiPreproductionEvent): Promise<void>;
  listEvents(context: RequestContext, limit?: number): Promise<PiPreproductionEvent[]>;
}
