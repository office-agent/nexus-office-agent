import type { RequestContext } from "@/src/platform/context/request-context";

export const PI_PILOT_JOURNEY_KINDS = [
  "new_feature",
  "bug_fix",
  "refactor",
  "test_failure_repair",
  "code_review",
  "pull_request",
] as const;

export type PiPilotJourneyKind = (typeof PI_PILOT_JOURNEY_KINDS)[number];
export type PiPilotStatus = "draft" | "active" | "paused" | "exited";
export type PiPilotParticipantStatus = "active" | "revoked";
export type PiPilotEvidenceStatus = "pending" | "verified" | "rejected";
export type PiPilotObservationMetric = "stability" | "quality" | "cost" | "security" | "adoption" | "data_access";
export type PiPilotIncidentSeverity = "P0" | "P1" | "P2" | "P3";
export type PiPilotIncidentStatus = "open" | "resolved";
export type PiPilotReadinessCategory = "journeys" | "stability" | "quality" | "cost" | "security" | "adoption" | "data" | "incidents" | "probe";
export type PiPilotReadinessCheckStatus = "pass" | "fail" | "warning";

export type PiPilot = {
  id: string;
  tenantId: string;
  createdBy: string;
  projectId: string;
  name: string;
  version: string;
  startsAt: string;
  endsAt: string;
  exitPolicyDigest: string;
  actionDigest: string;
  status: PiPilotStatus;
  createdAt: string;
  exitedAt?: string;
};

export type PiPilotParticipant = {
  id: string;
  tenantId: string;
  pilotId: string;
  subjectDigest: string;
  role: string;
  projectScopeDigest: string;
  status: PiPilotParticipantStatus;
  createdAt: string;
  revokedAt?: string;
};

export type PiPilotJourney = {
  id: string;
  tenantId: string;
  pilotId: string;
  kind: PiPilotJourneyKind;
  sampleDigest: string;
  status: PiPilotEvidenceStatus;
  evidenceDigest?: string;
  runDigest?: string;
  artifactDigest?: string;
  qualityScore?: number;
  createdAt: string;
};

export type PiPilotObservation = {
  id: string;
  tenantId: string;
  pilotId: string;
  metric: PiPilotObservationMetric;
  windowStart: string;
  windowEnd: string;
  value: number;
  threshold: number;
  unit: string;
  status: PiPilotEvidenceStatus;
  evidenceDigest?: string;
  createdAt: string;
};

export type PiPilotDataSample = {
  id: string;
  tenantId: string;
  pilotId: string;
  classification: "public" | "internal" | "confidential" | "restricted";
  sampleDigest: string;
  status: PiPilotEvidenceStatus;
  evidenceDigest?: string;
  createdAt: string;
};

export type PiPilotIncident = {
  id: string;
  tenantId: string;
  pilotId: string;
  severity: PiPilotIncidentSeverity;
  status: PiPilotIncidentStatus;
  summaryDigest: string;
  openedAt: string;
  resolvedAt?: string;
};

export type PiPilotReadinessCheck = {
  id: string;
  category: PiPilotReadinessCategory;
  status: PiPilotReadinessCheckStatus;
  message: string;
  evidenceDigest?: string;
};

export type PiPilotReadiness = {
  id: string;
  tenantId: string;
  actorId: string;
  pilotId: string;
  ready: boolean;
  checks: PiPilotReadinessCheck[];
  policyVersion: number;
  generatedAt: string;
  failureDigest?: string;
};

export type PiPilotEventKind =
  | "pi.pilot.created"
  | "pi.pilot.journey_recorded"
  | "pi.pilot.observation_recorded"
  | "pi.pilot.incident_recorded"
  | "pi.pilot.readiness_evaluated"
  | "pi.pilot.exited";

export type PiPilotEvent = {
  id: string;
  tenantId: string;
  actorId: string;
  pilotId: string;
  kind: PiPilotEventKind;
  subjectDigest: string;
  traceId: string;
  createdAt: string;
};

export type PiPilotSnapshot = {
  pilots: PiPilot[];
  participants: PiPilotParticipant[];
  journeys: PiPilotJourney[];
  observations: PiPilotObservation[];
  dataSamples: PiPilotDataSample[];
  incidents: PiPilotIncident[];
  readiness: PiPilotReadiness[];
  events: PiPilotEvent[];
  generatedAt: string;
};

export interface PiPilotStore {
  putPilot(pilot: PiPilot): Promise<{ pilot: PiPilot; created: boolean }>;
  findPilot(context: RequestContext, id: string): Promise<PiPilot | null>;
  findPilotByActionDigest(context: RequestContext, actionDigest: string): Promise<PiPilot | null>;
  listPilots(context: RequestContext): Promise<PiPilot[]>;
  putParticipant(participant: PiPilotParticipant): Promise<void>;
  findParticipant(context: RequestContext, pilotId: string, participantId: string): Promise<PiPilotParticipant | null>;
  listParticipants(context: RequestContext, pilotId?: string): Promise<PiPilotParticipant[]>;
  revokeParticipant(context: RequestContext, pilotId: string, participantId: string, revokedAt: string): Promise<PiPilotParticipant>;
  exitPilot(context: RequestContext, pilotId: string, exitedAt: string): Promise<PiPilot>;
  putJourney(journey: PiPilotJourney): Promise<void>;
  listJourneys(context: RequestContext, pilotId: string): Promise<PiPilotJourney[]>;
  putObservation(observation: PiPilotObservation): Promise<void>;
  listObservations(context: RequestContext, pilotId: string): Promise<PiPilotObservation[]>;
  putDataSample(sample: PiPilotDataSample): Promise<void>;
  listDataSamples(context: RequestContext, pilotId: string): Promise<PiPilotDataSample[]>;
  putIncident(incident: PiPilotIncident): Promise<void>;
  listIncidents(context: RequestContext, pilotId: string): Promise<PiPilotIncident[]>;
  putReadiness(readiness: PiPilotReadiness): Promise<void>;
  latestReadiness(context: RequestContext, pilotId: string): Promise<PiPilotReadiness | null>;
  listReadiness(context: RequestContext, limit?: number): Promise<PiPilotReadiness[]>;
  appendEvent(event: PiPilotEvent): Promise<void>;
  listEvents(context: RequestContext, limit?: number): Promise<PiPilotEvent[]>;
}
