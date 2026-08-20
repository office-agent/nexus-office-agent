import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { stableJson } from "@/src/modules/pi-agent/application/manifest";
import {
  type PiGateAttestation,
  type PiGateStatus,
  type PiPublication,
  type PiReleaseApproval,
  type PiReleaseEvaluation,
  type PiReleaseGateCheck,
  type PiReleaseGateEvaluation,
  type PiReleaseGovernanceEvent,
  type PiReleaseGovernanceEventKind,
  type PiReleaseGovernanceSnapshot,
  type PiReleaseGovernanceStore,
  type PiReleaseRisk,
  type PiRollout,
  type PiRolloutStage,
} from "@/src/modules/pi-agent/domain/release-governance-contracts";

export type PiPublicationDraft = {
  version: string;
  upstreamVersion: string;
  apiDigest: string;
  schemaDigest: string;
  imageDigest: string;
  signatureDigest: string;
  sbomDigest: string;
  rollbackDigest: string;
  pilotReadinessDigest?: string;
};

export type PiGateAttestationDraft = { gateId: string; evidenceDigest: string; validUntil: string };
export type PiReleaseRiskDraft = { severity: PiReleaseRisk["severity"]; summaryDigest: string; mitigationDigest?: string };
export type PiReleaseApprovalRequest = { role: PiReleaseApproval["role"]; expiresAt: string };
export type PiRolloutDraft = { scopeDigest: string; capabilityDigest: string; stage: PiRolloutStage; previousVersionDigest: string };
export type PiReleaseEvaluationDraft = { suiteDigest: string; score: number; threshold: number; evidenceDigest: string };

export interface PiReleaseEvidenceVerifier {
  verifyGate(context: RequestContext, publication: PiPublication, draft: PiGateAttestationDraft): Promise<Extract<PiGateStatus, "pass" | "pending" | "fail">>;
}

export class FailClosedPiReleaseEvidenceVerifier implements PiReleaseEvidenceVerifier {
  async verifyGate(): Promise<"pending"> { return "pending"; }
}

export interface PiReleaseGateProbe {
  probe(context: RequestContext, publication: PiPublication): Promise<PiReleaseGateCheck[]>;
}

export class FailClosedPiReleaseGate implements PiReleaseGateProbe {
  async probe(): Promise<PiReleaseGateCheck[]> {
    return [{ id: "release.external", status: "fail", message: "真实发布委员会、部署目标和外部 Gate 证据未接通，1.0 发布门禁保持关闭。" }];
  }
}

function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function assertText(value: string, code: string, max = 256): string { const normalized = value.trim(); if (!normalized || normalized.length > max) throw new Error(code); return normalized; }
function assertDigest(value: string | undefined, code: string, required = true): string | undefined { if (value === undefined && !required) return undefined; if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(code); return value.toLowerCase(); }
function assertId(value: string, code: string): string { const normalized = assertText(value, code, 128); if (!/^[0-9a-f-]{36}$/i.test(normalized)) throw new Error(code); return normalized; }
function assertDate(value: string, code: string): string { const normalized = assertText(value, code, 64); if (Number.isNaN(new Date(normalized).getTime())) throw new Error(code); return new Date(normalized).toISOString(); }
function assertVersion(value: string, code: string): string { const normalized = assertText(value, code, 64); if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/.test(normalized)) throw new Error(code); return normalized; }
function event(context: RequestContext, publicationId: string, kind: PiReleaseGovernanceEventKind, subject: unknown, createdAt: string): PiReleaseGovernanceEvent { return { id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, publicationId, kind, subjectDigest: digest(subject), traceId: context.traceId, createdAt }; }

const REQUIRED_GATES = Array.from({ length: 13 }, (_, index) => `G-${String(index + 25).padStart(3, "0")}`);

export class PiReleaseGovernanceService {
  private readonly policyVersion: number;

  constructor(
    private readonly store: PiReleaseGovernanceStore,
    private readonly verifier: PiReleaseEvidenceVerifier = new FailClosedPiReleaseEvidenceVerifier(),
    private readonly probe: PiReleaseGateProbe = new FailClosedPiReleaseGate(),
    options: { policyVersion?: number } = {},
  ) { this.policyVersion = options.policyVersion ?? 1; }

  async createPublication(context: RequestContext, draft: PiPublicationDraft, idempotencyKey?: string): Promise<PiPublication> {
    assertPiPermission(context, "pi:release:manage");
    const normalized = {
      version: assertVersion(draft.version, "PI_PUBLICATION_VERSION_INVALID"),
      upstreamVersion: assertVersion(draft.upstreamVersion, "PI_PUBLICATION_UPSTREAM_VERSION_INVALID"),
      apiDigest: assertDigest(draft.apiDigest, "PI_PUBLICATION_API_DIGEST_INVALID")!,
      schemaDigest: assertDigest(draft.schemaDigest, "PI_PUBLICATION_SCHEMA_DIGEST_INVALID")!,
      imageDigest: assertDigest(draft.imageDigest, "PI_PUBLICATION_IMAGE_DIGEST_INVALID")!,
      signatureDigest: assertDigest(draft.signatureDigest, "PI_PUBLICATION_SIGNATURE_DIGEST_INVALID")!,
      sbomDigest: assertDigest(draft.sbomDigest, "PI_PUBLICATION_SBOM_DIGEST_INVALID")!,
      rollbackDigest: assertDigest(draft.rollbackDigest, "PI_PUBLICATION_ROLLBACK_DIGEST_INVALID")!,
      pilotReadinessDigest: assertDigest(draft.pilotReadinessDigest, "PI_PUBLICATION_PILOT_DIGEST_INVALID", false),
    };
    const actionDigest = digest({ tenantId: context.tenantId, idempotencyKey: idempotencyKey?.trim() || undefined, ...normalized });
    const existing = await this.store.findPublicationByActionDigest(context, actionDigest);
    if (existing) return existing;
    const publication: PiPublication = { id: randomUUID(), tenantId: context.tenantId, createdBy: context.actorId, ...normalized, actionDigest, status: "candidate", createdAt: new Date().toISOString() };
    return (await this.store.putPublication(publication)).publication;
  }

  async listPublications(context: RequestContext): Promise<PiPublication[]> { assertPiPermission(context, "pi:release:read"); return this.store.listPublications(context); }

  private async publication(context: RequestContext, publicationId: string): Promise<PiPublication> {
    const publication = await this.store.findPublication(context, assertId(publicationId, "PI_PUBLICATION_ID_INVALID"));
    if (!publication) throw new Error("PI_PUBLICATION_NOT_FOUND");
    if (publication.status === "revoked") throw new Error("PI_PUBLICATION_STATE_CONFLICT");
    return publication;
  }

  async recordGateAttestation(context: RequestContext, publicationId: string, draft: PiGateAttestationDraft): Promise<PiGateAttestation> {
    assertPiPermission(context, "pi:release:manage");
    const publication = await this.publication(context, publicationId);
    const gateId = assertText(draft.gateId, "PI_GATE_ID_INVALID", 16).toUpperCase();
    if (!/^G-0(2[5-9]|3[0-7])$/.test(gateId)) throw new Error("PI_GATE_ID_INVALID");
    const validUntil = assertDate(draft.validUntil, "PI_GATE_VALIDITY_INVALID");
    const normalized = { gateId, evidenceDigest: assertDigest(draft.evidenceDigest, "PI_GATE_EVIDENCE_INVALID")!, validUntil };
    const status = await this.verifier.verifyGate(context, publication, normalized);
    const attestation: PiGateAttestation = { id: randomUUID(), tenantId: context.tenantId, publicationId: publication.id, ...normalized, status, policyVersion: this.policyVersion, createdBy: context.actorId, createdAt: new Date().toISOString() };
    await this.store.putGate(attestation);
    return attestation;
  }

  async recordRisk(context: RequestContext, publicationId: string, draft: PiReleaseRiskDraft): Promise<PiReleaseRisk> {
    assertPiPermission(context, "pi:release:manage");
    const publication = await this.publication(context, publicationId);
    const risk: PiReleaseRisk = { id: randomUUID(), tenantId: context.tenantId, publicationId: publication.id, severity: draft.severity, status: "open", summaryDigest: assertDigest(draft.summaryDigest, "PI_RELEASE_RISK_INVALID")!, mitigationDigest: assertDigest(draft.mitigationDigest, "PI_RELEASE_MITIGATION_INVALID", false), createdBy: context.actorId, createdAt: new Date().toISOString() };
    await this.store.putRisk(risk);
    return risk;
  }

  async resolveRisk(context: RequestContext, publicationId: string, riskId: string, mitigationDigest: string): Promise<PiReleaseRisk> {
    assertPiPermission(context, "pi:release:manage");
    await this.publication(context, publicationId);
    return this.store.resolveRisk(context, assertId(publicationId, "PI_PUBLICATION_ID_INVALID"), assertId(riskId, "PI_RELEASE_RISK_ID_INVALID"), assertDigest(mitigationDigest, "PI_RELEASE_MITIGATION_INVALID")!, new Date().toISOString());
  }

  async requestApproval(context: RequestContext, publicationId: string, draft: PiReleaseApprovalRequest): Promise<PiReleaseApproval> {
    assertPiPermission(context, "pi:release:approve");
    const publication = await this.publication(context, publicationId);
    const expiresAt = assertDate(draft.expiresAt, "PI_RELEASE_APPROVAL_EXPIRY_INVALID");
    if (new Date(expiresAt).getTime() <= Date.now()) throw new Error("PI_RELEASE_APPROVAL_EXPIRY_INVALID");
    const gates = await this.store.listGates(context, publication.id);
    const risks = await this.store.listRisks(context, publication.id);
    const proposalHash = digest({ publication, gates: gates.map((item) => ({ gateId: item.gateId, status: item.status, evidenceDigest: item.evidenceDigest })), risks: risks.map((item) => ({ id: item.id, severity: item.severity, status: item.status })) });
    const approval: PiReleaseApproval = { id: randomUUID(), tenantId: context.tenantId, publicationId: publication.id, actorId: context.actorId, role: draft.role, decision: "pending", proposalHash, expiresAt, createdAt: new Date().toISOString() };
    await this.store.putApproval(approval);
    return approval;
  }

  async recordApproval(context: RequestContext, publicationId: string, approvalId: string, decision: "approved" | "rejected"): Promise<PiReleaseApproval> {
    assertPiPermission(context, "pi:release:approve");
    const publication = await this.publication(context, publicationId);
    const pending = (await this.store.listApprovals(context, publication.id)).find((item) => item.id === assertId(approvalId, "PI_RELEASE_APPROVAL_ID_INVALID") && item.decision === "pending");
    if (!pending) throw new Error("PI_RELEASE_APPROVAL_NOT_FOUND");
    if (pending.actorId === context.actorId) throw new Error("PI_RELEASE_APPROVAL_SOD_REQUIRED");
    if (new Date(pending.expiresAt).getTime() <= Date.now()) throw new Error("PI_RELEASE_APPROVAL_EXPIRED");
    const recorded: PiReleaseApproval = { ...pending, id: randomUUID(), actorId: context.actorId, decision };
    await this.store.putApproval(recorded);
    return recorded;
  }

  async evaluateReleaseGate(context: RequestContext, publicationId: string): Promise<PiReleaseGateEvaluation> {
    assertPiPermission(context, "pi:release:read");
    const publication = await this.publication(context, publicationId);
    const [gates, risks, approvals] = await Promise.all([this.store.listGates(context, publication.id), this.store.listRisks(context, publication.id), this.store.listApprovals(context, publication.id)]);
    const latest = new Map<string, PiGateAttestation>();
    for (const gate of gates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) if (!latest.has(gate.gateId)) latest.set(gate.gateId, gate);
    const checks: PiReleaseGateCheck[] = REQUIRED_GATES.map((gateId) => {
      const item = latest.get(gateId);
      if (!item) return { id: gateId, status: "pending", message: "尚未登记该 Gate 的服务端验证证据。" };
      if (new Date(item.validUntil).getTime() <= Date.now()) return { id: gateId, status: "expired", message: "Gate 证据已过期。", evidenceDigest: item.evidenceDigest };
      return { id: gateId, status: item.status, message: item.status === "pass" ? "Gate 证据已通过验证。" : "Gate 证据尚未通过服务端验证。", evidenceDigest: item.evidenceDigest };
    });
    const unresolvedHighRisk = risks.filter((risk) => (risk.severity === "P0" || risk.severity === "P1") && risk.status === "open");
    checks.push({ id: "release.risks", status: unresolvedHighRisk.length === 0 ? "pass" : "fail", message: unresolvedHighRisk.length === 0 ? "没有未解决的 P0/P1 发布风险。" : `仍有 ${unresolvedHighRisk.length} 个未解决的 P0/P1 发布风险。` });
    const approved = approvals.filter((item) => item.decision === "approved" && new Date(item.expiresAt).getTime() > Date.now());
    const approverActors = new Set(approved.map((item) => item.actorId));
    const approverRoles = new Set(approved.map((item) => item.role));
    checks.push({ id: "release.approvals", status: approverActors.size >= 2 && approverRoles.size >= 2 ? "pass" : "fail", message: approverActors.size >= 2 && approverRoles.size >= 2 ? "双人且职责分离的发布签字已验证。" : "发布签字不足两名不同主体或职责未分离。" });
    checks.push({ id: "release.artifacts", status: [publication.signatureDigest, publication.sbomDigest, publication.rollbackDigest].every(Boolean) ? "pass" : "fail", message: "签名制品、SBOM 和回退点摘要必须齐全。" });
    try { checks.push(...await this.probe.probe(context, publication)); } catch { checks.push({ id: "release.probe.failed", status: "fail", message: "真实发布 Gate 探针异常，门禁保持关闭。" }); }
    const ready = checks.length > 0 && checks.every((check) => check.status === "pass");
    const generatedAt = new Date().toISOString();
    const evaluation: PiReleaseGateEvaluation = { id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, publicationId: publication.id, ready, checks, policyVersion: this.policyVersion, generatedAt, ...(ready ? {} : { failureDigest: digest(checks.filter((check) => check.status !== "pass")) }) };
    await this.store.putGateEvaluation(evaluation);
    await this.store.appendEvent(event(context, publication.id, "pi.publication.gate_evaluated", { id: evaluation.id, ready }, generatedAt));
    if (ready) {
      const approvedPublication = await this.store.updatePublication(context, publication.id, { status: "approved", approvedAt: generatedAt });
      await this.store.appendEvent(event(context, approvedPublication.id, "pi.publication.approved", approvedPublication.actionDigest, generatedAt));
    }
    return evaluation;
  }

  async startRollout(context: RequestContext, publicationId: string, draft: PiRolloutDraft, idempotencyKey?: string): Promise<PiRollout> {
    assertPiPermission(context, "pi:release:rollout");
    const publication = await this.publication(context, publicationId);
    const evaluation = await this.store.latestGateEvaluation(context, publication.id);
    if (!evaluation?.ready || publication.status !== "approved") throw new Error("PI_RELEASE_GATE_NOT_READY");
    const normalized = { scopeDigest: assertDigest(draft.scopeDigest, "PI_ROLLOUT_SCOPE_INVALID")!, capabilityDigest: assertDigest(draft.capabilityDigest, "PI_ROLLOUT_CAPABILITY_INVALID")!, stage: draft.stage, previousVersionDigest: assertDigest(draft.previousVersionDigest, "PI_ROLLOUT_PREVIOUS_VERSION_INVALID")! };
    const actionDigest = digest({ tenantId: context.tenantId, publicationId: publication.id, idempotencyKey: idempotencyKey?.trim() || undefined, ...normalized });
    const existing = (await this.store.listRollouts(context, publication.id)).find((item) => item.actionDigest === actionDigest);
    if (existing) return existing;
    const changedAt = new Date().toISOString();
    const rollout: PiRollout = { id: randomUUID(), tenantId: context.tenantId, publicationId: publication.id, ...normalized, status: "running", actionDigest, createdAt: changedAt, changedAt };
    await this.store.putRollout(rollout);
    await this.store.updatePublication(context, publication.id, { status: "rolling_out" });
    await this.store.appendEvent(event(context, publication.id, "pi.publication.rollout_changed", { rolloutId: rollout.id, stage: rollout.stage, status: rollout.status }, changedAt));
    return rollout;
  }

  async advanceRollout(context: RequestContext, rolloutId: string): Promise<PiRollout> {
    assertPiPermission(context, "pi:release:rollout");
    const rollout = await this.store.findRollout(context, assertId(rolloutId, "PI_ROLLOUT_ID_INVALID"));
    if (!rollout) throw new Error("PI_ROLLOUT_NOT_FOUND");
    if (rollout.status !== "running") throw new Error("PI_ROLLOUT_STATE_CONFLICT");
    const next: PiRolloutStage | undefined = rollout.stage === "canary" ? "pilot" : rollout.stage === "pilot" ? "general" : undefined;
    if (!next) throw new Error("PI_ROLLOUT_STATE_CONFLICT");
    const changedAt = new Date().toISOString();
    const updated = await this.store.updateRollout(context, rollout.id, { stage: next, status: next === "general" ? "completed" : "running", changedAt });
    if (updated.status === "completed") await this.store.updatePublication(context, rollout.publicationId, { status: "active" });
    await this.store.appendEvent(event(context, rollout.publicationId, "pi.publication.rollout_changed", { rolloutId: updated.id, stage: updated.stage, status: updated.status }, changedAt));
    return updated;
  }

  async rollbackRollout(context: RequestContext, rolloutId: string): Promise<PiRollout> {
    assertPiPermission(context, "pi:release:rollout");
    const rollout = await this.store.findRollout(context, assertId(rolloutId, "PI_ROLLOUT_ID_INVALID"));
    if (!rollout) throw new Error("PI_ROLLOUT_NOT_FOUND");
    if (rollout.status === "rolled_back") return rollout;
    if (rollout.status !== "running" && rollout.status !== "completed") throw new Error("PI_ROLLOUT_STATE_CONFLICT");
    const changedAt = new Date().toISOString();
    const updated = await this.store.updateRollout(context, rollout.id, { status: "rolled_back", changedAt });
    await this.store.updatePublication(context, rollout.publicationId, { status: "rolled_back" });
    await this.store.appendEvent(event(context, rollout.publicationId, "pi.publication.rollout_changed", { rolloutId: updated.id, status: updated.status }, changedAt));
    return updated;
  }

  async revokePublication(context: RequestContext, publicationId: string): Promise<PiPublication> {
    assertPiPermission(context, "pi:release:revoke");
    const publication = await this.store.findPublication(context, assertId(publicationId, "PI_PUBLICATION_ID_INVALID"));
    if (!publication) throw new Error("PI_PUBLICATION_NOT_FOUND");
    if (publication.status === "revoked") return publication;
    const revokedAt = new Date().toISOString();
    const revoked = await this.store.updatePublication(context, publication.id, { status: "revoked", revokedAt });
    await this.store.appendEvent(event(context, revoked.id, "pi.publication.revoked", revoked.actionDigest, revokedAt));
    return revoked;
  }

  async rollbackPublication(context: RequestContext, publicationId: string): Promise<PiPublication> {
    assertPiPermission(context, "pi:release:rollout");
    const publication = await this.store.findPublication(context, assertId(publicationId, "PI_PUBLICATION_ID_INVALID"));
    if (!publication) throw new Error("PI_PUBLICATION_NOT_FOUND");
    if (publication.status === "rolled_back") return publication;
    if (publication.status !== "active" && publication.status !== "rolling_out") throw new Error("PI_PUBLICATION_STATE_CONFLICT");
    const rollout = (await this.store.listRollouts(context, publication.id)).find((item) => item.status === "running" || item.status === "completed");
    const changedAt = new Date().toISOString();
    if (rollout) await this.store.updateRollout(context, rollout.id, { status: "rolled_back", changedAt });
    const rolledBack = await this.store.updatePublication(context, publication.id, { status: "rolled_back" });
    await this.store.appendEvent(event(context, publication.id, "pi.publication.rollout_changed", { rolloutId: rollout?.id, status: "rolled_back" }, changedAt));
    return rolledBack;
  }

  async recordEvaluation(context: RequestContext, publicationId: string, draft: PiReleaseEvaluationDraft): Promise<PiReleaseEvaluation> {
    assertPiPermission(context, "pi:release:manage");
    const publication = await this.publication(context, publicationId);
    if (!Number.isFinite(draft.score) || !Number.isFinite(draft.threshold) || draft.score < 0 || draft.score > 1 || draft.threshold < 0 || draft.threshold > 1) throw new Error("PI_RELEASE_EVALUATION_INVALID");
    const evaluation: PiReleaseEvaluation = { id: randomUUID(), tenantId: context.tenantId, publicationId: publication.id, status: draft.score >= draft.threshold ? "passed" : "regressed", suiteDigest: assertDigest(draft.suiteDigest, "PI_RELEASE_SUITE_INVALID")!, score: draft.score, threshold: draft.threshold, evidenceDigest: assertDigest(draft.evidenceDigest, "PI_RELEASE_EVIDENCE_INVALID")!, createdAt: new Date().toISOString() };
    await this.store.putEvaluation(evaluation);
    return evaluation;
  }

  async snapshot(context: RequestContext): Promise<PiReleaseGovernanceSnapshot> {
    assertPiPermission(context, "pi:release:read");
    const publications = await this.store.listPublications(context);
    const grouped = await Promise.all(publications.map(async (publication) => Promise.all([this.store.listGates(context, publication.id), this.store.listRisks(context, publication.id), this.store.listApprovals(context, publication.id), this.store.listRollouts(context, publication.id), this.store.listEvaluations(context, publication.id)])));
    return { publications, gates: grouped.flatMap((item) => item[0]), risks: grouped.flatMap((item) => item[1]), approvals: grouped.flatMap((item) => item[2]), rollouts: grouped.flatMap((item) => item[3]), evaluations: grouped.flatMap((item) => item[4]), gateEvaluations: await this.store.listGateEvaluations(context, 200), events: await this.store.listEvents(context, 200), generatedAt: new Date().toISOString() };
  }
}
