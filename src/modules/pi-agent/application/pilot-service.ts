import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { stableJson } from "@/src/modules/pi-agent/application/manifest";
import {
  PI_PILOT_JOURNEY_KINDS,
  type PiPilot,
  type PiPilotDataSample,
  type PiPilotEvent,
  type PiPilotEventKind,
  type PiPilotIncident,
  type PiPilotJourney,
  type PiPilotJourneyKind,
  type PiPilotObservation,
  type PiPilotParticipant,
  type PiPilotReadiness,
  type PiPilotReadinessCheck,
  type PiPilotSnapshot,
  type PiPilotStore,
} from "@/src/modules/pi-agent/domain/pilot-contracts";

export type PiPilotDraft = {
  projectId: string;
  name: string;
  version: string;
  startsAt: string;
  endsAt: string;
  exitPolicyDigest: string;
};

export type PiPilotParticipantDraft = {
  subjectDigest: string;
  role: string;
  projectScopeDigest: string;
};

export type PiPilotJourneyDraft = {
  kind: PiPilotJourneyKind;
  sampleDigest: string;
  runDigest?: string;
  artifactDigest?: string;
  qualityScore?: number;
};

export type PiPilotObservationDraft = {
  metric: PiPilotObservation["metric"];
  windowStart: string;
  windowEnd: string;
  value: number;
  threshold: number;
  unit: string;
  evidenceDigest?: string;
};

export type PiPilotDataSampleDraft = {
  classification: PiPilotDataSample["classification"];
  sampleDigest: string;
  evidenceDigest?: string;
};

export type PiPilotIncidentDraft = {
  severity: PiPilotIncident["severity"];
  status?: PiPilotIncident["status"];
  summaryDigest: string;
  resolvedAt?: string;
};

export interface PiPilotEvidenceVerifier {
  verifyJourney(context: RequestContext, pilot: PiPilot, draft: PiPilotJourneyDraft): Promise<"verified" | "pending" | "rejected">;
  verifyObservation(context: RequestContext, pilot: PiPilot, draft: PiPilotObservationDraft): Promise<"verified" | "pending" | "rejected">;
  verifyDataSample(context: RequestContext, pilot: PiPilot, draft: PiPilotDataSampleDraft): Promise<"verified" | "pending" | "rejected">;
}

export class FailClosedPiPilotEvidenceVerifier implements PiPilotEvidenceVerifier {
  async verifyJourney(): Promise<"pending"> { return "pending"; }
  async verifyObservation(): Promise<"pending"> { return "pending"; }
  async verifyDataSample(): Promise<"pending"> { return "pending"; }
}

export interface PiPilotReadinessProbe {
  probe(context: RequestContext, pilot: PiPilot): Promise<PiPilotReadinessCheck[]>;
}

export class FailClosedPiPilotProbe implements PiPilotReadinessProbe {
  async probe(): Promise<PiPilotReadinessCheck[]> {
    return [{ id: "pilot.external", category: "probe", status: "fail", message: "真实试点授权、项目运行和外部证据探针未接通，试点门禁保持关闭。" }];
  }
}

function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }

function assertText(value: string, code: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(code);
  return normalized;
}

function assertDigest(value: string | undefined, code: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function assertId(value: string, code: string): string {
  const normalized = assertText(value, code, 128);
  if (!/^[0-9a-f-]{36}$/i.test(normalized)) throw new Error(code);
  return normalized;
}

function assertDate(value: string, code: string): string {
  const normalized = assertText(value, code, 64);
  if (Number.isNaN(new Date(normalized).getTime())) throw new Error(code);
  return new Date(normalized).toISOString();
}

function assertJourneyKind(value: string): PiPilotJourneyKind {
  if (!PI_PILOT_JOURNEY_KINDS.includes(value as PiPilotJourneyKind)) throw new Error("PI_PILOT_JOURNEY_KIND_INVALID");
  return value as PiPilotJourneyKind;
}

function event(context: RequestContext, pilotId: string, kind: PiPilotEventKind, subject: unknown, createdAt: string): PiPilotEvent {
  return { id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, pilotId, kind, subjectDigest: digest(subject), traceId: context.traceId, createdAt };
}

function failureDigest(checks: PiPilotReadinessCheck[]): string | undefined {
  const failures = checks.filter((check) => check.status !== "pass");
  return failures.length > 0 ? digest(failures) : undefined;
}

function durationDays(startsAt: string, endsAt: string): number { return (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 86_400_000; }

export class PiPilotService {
  private readonly policyVersion: number;

  constructor(
    private readonly store: PiPilotStore,
    private readonly verifier: PiPilotEvidenceVerifier = new FailClosedPiPilotEvidenceVerifier(),
    private readonly probe: PiPilotReadinessProbe = new FailClosedPiPilotProbe(),
    options: { policyVersion?: number } = {},
  ) { this.policyVersion = options.policyVersion ?? 1; }

  async createPilot(context: RequestContext, draft: PiPilotDraft, idempotencyKey?: string): Promise<PiPilot> {
    assertPiPermission(context, "pi:pilot:manage");
    const startsAt = assertDate(draft.startsAt, "PI_PILOT_WINDOW_INVALID");
    const endsAt = assertDate(draft.endsAt, "PI_PILOT_WINDOW_INVALID");
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime() || durationDays(startsAt, endsAt) > 90) throw new Error("PI_PILOT_WINDOW_INVALID");
    const normalized = {
      projectId: assertText(draft.projectId, "PI_PILOT_PROJECT_INVALID", 256),
      name: assertText(draft.name, "PI_PILOT_NAME_INVALID", 128),
      version: assertText(draft.version, "PI_PILOT_VERSION_INVALID", 64),
      startsAt,
      endsAt,
      exitPolicyDigest: assertDigest(draft.exitPolicyDigest, "PI_PILOT_EXIT_POLICY_INVALID")!,
    };
    const actionDigest = digest({ tenantId: context.tenantId, idempotencyKey: idempotencyKey?.trim() || undefined, ...normalized });
    const existing = await this.store.findPilotByActionDigest(context, actionDigest);
    if (existing) return existing;
    const pilot: PiPilot = { id: randomUUID(), tenantId: context.tenantId, createdBy: context.actorId, ...normalized, actionDigest, status: "active", createdAt: new Date().toISOString() };
    const result = await this.store.putPilot(pilot);
    await this.store.appendEvent(event(context, result.pilot.id, "pi.pilot.created", result.pilot.actionDigest, result.pilot.createdAt));
    return result.pilot;
  }

  async listPilots(context: RequestContext): Promise<PiPilot[]> { assertPiPermission(context, "pi:pilot:read"); return this.store.listPilots(context); }

  async addParticipant(context: RequestContext, pilotId: string, draft: PiPilotParticipantDraft): Promise<PiPilotParticipant> {
    assertPiPermission(context, "pi:pilot:manage");
    const id = assertId(pilotId, "PI_PILOT_ID_INVALID");
    const pilot = await this.store.findPilot(context, id);
    if (!pilot) throw new Error("PI_PILOT_NOT_FOUND");
    if (pilot.status === "exited") throw new Error("PI_PILOT_STATE_CONFLICT");
    const participant: PiPilotParticipant = {
      id: randomUUID(), tenantId: context.tenantId, pilotId: id,
      subjectDigest: assertDigest(draft.subjectDigest, "PI_PILOT_SUBJECT_INVALID")!,
      role: assertText(draft.role, "PI_PILOT_ROLE_INVALID", 64),
      projectScopeDigest: assertDigest(draft.projectScopeDigest, "PI_PILOT_SCOPE_INVALID")!, status: "active", createdAt: new Date().toISOString(),
    };
    const existing = (await this.store.listParticipants(context, id)).find((item) => item.subjectDigest === participant.subjectDigest && item.status === "active");
    if (existing) return existing;
    await this.store.putParticipant(participant);
    return participant;
  }

  async revokeParticipant(context: RequestContext, pilotId: string, participantId: string): Promise<PiPilotParticipant> {
    assertPiPermission(context, "pi:pilot:exit");
    return this.store.revokeParticipant(context, assertId(pilotId, "PI_PILOT_ID_INVALID"), assertId(participantId, "PI_PILOT_PARTICIPANT_ID_INVALID"), new Date().toISOString());
  }

  private async activePilot(context: RequestContext, pilotId: string): Promise<PiPilot> {
    const pilot = await this.store.findPilot(context, assertId(pilotId, "PI_PILOT_ID_INVALID"));
    if (!pilot) throw new Error("PI_PILOT_NOT_FOUND");
    if (pilot.status === "exited") throw new Error("PI_PILOT_STATE_CONFLICT");
    return pilot;
  }

  async recordJourney(context: RequestContext, pilotId: string, draft: PiPilotJourneyDraft): Promise<PiPilotJourney> {
    assertPiPermission(context, "pi:pilot:manage");
    const pilot = await this.activePilot(context, pilotId);
    const normalized = { ...draft, kind: assertJourneyKind(draft.kind), sampleDigest: assertDigest(draft.sampleDigest, "PI_PILOT_SAMPLE_INVALID")!, runDigest: assertDigest(draft.runDigest, "PI_PILOT_RUN_INVALID", false), artifactDigest: assertDigest(draft.artifactDigest, "PI_PILOT_ARTIFACT_INVALID", false) };
    if (draft.qualityScore !== undefined && (!Number.isFinite(draft.qualityScore) || draft.qualityScore < 0 || draft.qualityScore > 1)) throw new Error("PI_PILOT_SCORE_INVALID");
    const status = await this.verifier.verifyJourney(context, pilot, normalized);
    const journey: PiPilotJourney = { id: randomUUID(), tenantId: context.tenantId, pilotId: pilot.id, ...normalized, status, createdAt: new Date().toISOString() };
    await this.store.putJourney(journey);
    await this.store.appendEvent(event(context, pilot.id, "pi.pilot.journey_recorded", { id: journey.id, kind: journey.kind, status: journey.status }, journey.createdAt));
    return journey;
  }

  async recordObservation(context: RequestContext, pilotId: string, draft: PiPilotObservationDraft): Promise<PiPilotObservation> {
    assertPiPermission(context, "pi:pilot:manage");
    const pilot = await this.activePilot(context, pilotId);
    const windowStart = assertDate(draft.windowStart, "PI_PILOT_OBSERVATION_WINDOW_INVALID");
    const windowEnd = assertDate(draft.windowEnd, "PI_PILOT_OBSERVATION_WINDOW_INVALID");
    if (new Date(windowEnd).getTime() < new Date(windowStart).getTime() || !Number.isFinite(draft.value) || !Number.isFinite(draft.threshold)) throw new Error("PI_PILOT_OBSERVATION_INVALID");
    const normalized = { ...draft, windowStart, windowEnd, unit: assertText(draft.unit, "PI_PILOT_OBSERVATION_UNIT_INVALID", 32), evidenceDigest: assertDigest(draft.evidenceDigest, "PI_PILOT_EVIDENCE_INVALID", false) };
    const status = await this.verifier.verifyObservation(context, pilot, normalized);
    const observation: PiPilotObservation = { id: randomUUID(), tenantId: context.tenantId, pilotId: pilot.id, ...normalized, status, createdAt: new Date().toISOString() };
    await this.store.putObservation(observation);
    await this.store.appendEvent(event(context, pilot.id, "pi.pilot.observation_recorded", { id: observation.id, metric: observation.metric, status: observation.status }, observation.createdAt));
    return observation;
  }

  async recordDataSample(context: RequestContext, pilotId: string, draft: PiPilotDataSampleDraft): Promise<PiPilotDataSample> {
    assertPiPermission(context, "pi:pilot:manage");
    const pilot = await this.activePilot(context, pilotId);
    const normalized = { ...draft, sampleDigest: assertDigest(draft.sampleDigest, "PI_PILOT_SAMPLE_INVALID")!, evidenceDigest: assertDigest(draft.evidenceDigest, "PI_PILOT_EVIDENCE_INVALID", false) };
    const status = await this.verifier.verifyDataSample(context, pilot, normalized);
    const sample: PiPilotDataSample = { id: randomUUID(), tenantId: context.tenantId, pilotId: pilot.id, ...normalized, status, createdAt: new Date().toISOString() };
    await this.store.putDataSample(sample);
    return sample;
  }

  async recordIncident(context: RequestContext, pilotId: string, draft: PiPilotIncidentDraft): Promise<PiPilotIncident> {
    assertPiPermission(context, "pi:pilot:manage");
    const pilot = await this.activePilot(context, pilotId);
    const openedAt = new Date().toISOString();
    const incident: PiPilotIncident = { id: randomUUID(), tenantId: context.tenantId, pilotId: pilot.id, severity: draft.severity, status: draft.status ?? "open", summaryDigest: assertDigest(draft.summaryDigest, "PI_PILOT_INCIDENT_INVALID")!, openedAt, ...(draft.status === "resolved" ? { resolvedAt: assertDate(draft.resolvedAt ?? openedAt, "PI_PILOT_INCIDENT_INVALID") } : {}) };
    await this.store.putIncident(incident);
    await this.store.appendEvent(event(context, pilot.id, "pi.pilot.incident_recorded", { id: incident.id, severity: incident.severity, status: incident.status }, openedAt));
    return incident;
  }

  async evaluateReadiness(context: RequestContext, pilotId: string): Promise<PiPilotReadiness> {
    assertPiPermission(context, "pi:pilot:read");
    const pilot = await this.store.findPilot(context, assertId(pilotId, "PI_PILOT_ID_INVALID"));
    if (!pilot) throw new Error("PI_PILOT_NOT_FOUND");
    const [journeys, observations, dataSamples, incidents] = await Promise.all([
      this.store.listJourneys(context, pilot.id), this.store.listObservations(context, pilot.id), this.store.listDataSamples(context, pilot.id), this.store.listIncidents(context, pilot.id),
    ]);
    const checks: PiPilotReadinessCheck[] = [];
    for (const kind of PI_PILOT_JOURNEY_KINDS) {
      const count = journeys.filter((journey) => journey.kind === kind && journey.status === "verified").length;
      checks.push({ id: `journey.${kind}`, category: "journeys", status: count >= 3 ? "pass" : "fail", message: `${kind} 已验证样本 ${count}/3`, evidenceDigest: digest({ pilotId: pilot.id, kind, count }) });
    }
    const windowPass = durationDays(pilot.startsAt, pilot.endsAt) >= 28 && new Date(pilot.endsAt).getTime() <= Date.now();
    checks.push({ id: "pilot.window", category: "stability", status: windowPass ? "pass" : "fail", message: windowPass ? "试点窗口已完成至少 28 天。" : "试点窗口不足 28 天或尚未结束。", evidenceDigest: digest({ startsAt: pilot.startsAt, endsAt: pilot.endsAt }) });
    for (const metric of ["stability", "quality", "cost", "security", "adoption"] as const) {
      const passed = observations.some((item) => item.metric === metric && item.status === "verified");
      checks.push({ id: `observation.${metric}`, category: metric === "stability" ? "stability" : metric, status: passed ? "pass" : "fail", message: passed ? `${metric} 观察证据已验证。` : `${metric} 尚无已验证观察证据。` });
    }
    const dataPass = dataSamples.some((item) => item.status === "verified");
    checks.push({ id: "pilot.data", category: "data", status: dataPass ? "pass" : "fail", message: dataPass ? "权限与最小数据抽检证据已验证。" : "权限与最小数据抽检证据未验证。" });
    const activeHighIncident = incidents.some((item) => item.status === "open" && (item.severity === "P0" || item.severity === "P1"));
    checks.push({ id: "pilot.incidents", category: "incidents", status: activeHighIncident ? "fail" : "pass", message: activeHighIncident ? "存在未处置的 P0/P1 试点事故。" : "没有未处置的 P0/P1 试点事故。" });
    try { checks.push(...await this.probe.probe(context, pilot)); } catch { checks.push({ id: "pilot.probe.failed", category: "probe", status: "fail", message: "试点外部证据探针异常，门禁保持关闭。" }); }
    const generatedAt = new Date().toISOString();
    const readiness: PiPilotReadiness = { id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, pilotId: pilot.id, ready: pilot.status === "active" && checks.length > 0 && checks.every((check) => check.status === "pass"), checks, policyVersion: this.policyVersion, generatedAt, ...(failureDigest(checks) ? { failureDigest: failureDigest(checks) } : {}) };
    await this.store.putReadiness(readiness);
    await this.store.appendEvent(event(context, pilot.id, "pi.pilot.readiness_evaluated", { readinessId: readiness.id, ready: readiness.ready }, generatedAt));
    return readiness;
  }

  async latestReadiness(context: RequestContext, pilotId: string): Promise<PiPilotReadiness | null> { assertPiPermission(context, "pi:pilot:read"); return this.store.latestReadiness(context, assertId(pilotId, "PI_PILOT_ID_INVALID")); }

  async exitPilot(context: RequestContext, pilotId: string): Promise<PiPilot> {
    assertPiPermission(context, "pi:pilot:exit");
    const id = assertId(pilotId, "PI_PILOT_ID_INVALID");
    const pilot = await this.store.findPilot(context, id);
    if (!pilot) throw new Error("PI_PILOT_NOT_FOUND");
    if (pilot.status === "exited") return pilot;
    const exitedAt = new Date().toISOString();
    const exited = await this.store.exitPilot(context, id, exitedAt);
    await this.store.appendEvent(event(context, exited.id, "pi.pilot.exited", exited.exitPolicyDigest, exitedAt));
    return exited;
  }

  async listEvents(context: RequestContext, limit = 100): Promise<PiPilotEvent[]> { assertPiPermission(context, "pi:pilot:read"); return this.store.listEvents(context, Math.min(Math.max(limit, 1), 1000)); }

  async snapshot(context: RequestContext): Promise<PiPilotSnapshot> {
    assertPiPermission(context, "pi:pilot:read");
    const pilots = await this.store.listPilots(context);
    const parts = await Promise.all(pilots.map(async (pilot) => Promise.all([this.store.listParticipants(context, pilot.id), this.store.listJourneys(context, pilot.id), this.store.listObservations(context, pilot.id), this.store.listDataSamples(context, pilot.id), this.store.listIncidents(context, pilot.id)])));
    const readiness = await this.store.listReadiness(context, 200);
    return { pilots, participants: parts.flatMap((item) => item[0]), journeys: parts.flatMap((item) => item[1]), observations: parts.flatMap((item) => item[2]), dataSamples: parts.flatMap((item) => item[3]), incidents: parts.flatMap((item) => item[4]), readiness, events: await this.store.listEvents(context, 200), generatedAt: new Date().toISOString() };
  }
}
