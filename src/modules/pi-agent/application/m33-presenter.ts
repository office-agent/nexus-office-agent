import type {
  PiPilot,
  PiPilotDataSample,
  PiPilotEvent,
  PiPilotIncident,
  PiPilotJourney,
  PiPilotObservation,
  PiPilotParticipant,
  PiPilotReadiness,
  PiPilotSnapshot,
} from "@/src/modules/pi-agent/domain/pilot-contracts";

function withoutInternal<T extends Record<string, unknown>>(value: T, fields: string[]): Omit<T, keyof T> & Record<string, unknown> {
  const copy = { ...value } as Record<string, unknown>;
  for (const field of fields) delete copy[field];
  return copy as Omit<T, keyof T> & Record<string, unknown>;
}

export function presentPilot(item: PiPilot) { return withoutInternal(item, ["tenantId", "createdBy"]); }
export function presentParticipant(item: PiPilotParticipant) { return withoutInternal(item, ["tenantId", "subjectDigest"]); }
export function presentJourney(item: PiPilotJourney) { return withoutInternal(item, ["tenantId"]); }
export function presentObservation(item: PiPilotObservation) { return withoutInternal(item, ["tenantId"]); }
export function presentDataSample(item: PiPilotDataSample) { return withoutInternal(item, ["tenantId", "sampleDigest"]); }
export function presentIncident(item: PiPilotIncident) { return withoutInternal(item, ["tenantId"]); }
export function presentPilotReadiness(item: PiPilotReadiness) { return withoutInternal(item, ["tenantId", "actorId"]); }
export function presentPilotEvent(item: PiPilotEvent) { return withoutInternal(item, ["tenantId", "actorId"]); }

export function presentPilotSnapshot(snapshot: PiPilotSnapshot) {
  return {
    pilots: snapshot.pilots.map(presentPilot),
    participants: snapshot.participants.map(presentParticipant),
    journeys: snapshot.journeys.map(presentJourney),
    observations: snapshot.observations.map(presentObservation),
    dataSamples: snapshot.dataSamples.map(presentDataSample),
    incidents: snapshot.incidents.map(presentIncident),
    readiness: snapshot.readiness.map(presentPilotReadiness),
    events: snapshot.events.map(presentPilotEvent),
    generatedAt: snapshot.generatedAt,
  };
}
