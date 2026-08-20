import type { PiPreproductionEvent, PiPreproductionSnapshot, PiReadinessSnapshot, PiReleaseCandidate, PiSecretLease } from "@/src/modules/pi-agent/domain/preproduction-contracts";

export function presentRelease(release: PiReleaseCandidate) {
  const { tenantId, createdBy, ...safe } = release;
  void tenantId; void createdBy;
  return safe;
}

export function presentReadiness(snapshot: PiReadinessSnapshot) {
  const { tenantId, actorId, ...safe } = snapshot;
  void tenantId; void actorId;
  return safe;
}

export function presentSecretLease(lease: PiSecretLease) {
  const { tenantId, actorId, revokeActorId, ...safe } = lease;
  void tenantId; void actorId; void revokeActorId;
  return safe;
}

export function presentPreproductionEvent(item: PiPreproductionEvent) {
  const { tenantId, actorId, ...safe } = item;
  void tenantId; void actorId;
  return safe;
}

export function presentPreproduction(snapshot: PiPreproductionSnapshot) {
  return {
    releases: snapshot.releases.map(presentRelease),
    readiness: snapshot.readiness.map(presentReadiness),
    secretLeases: snapshot.secretLeases.map(presentSecretLease),
    events: snapshot.events.map(presentPreproductionEvent),
    generatedAt: snapshot.generatedAt,
  };
}
