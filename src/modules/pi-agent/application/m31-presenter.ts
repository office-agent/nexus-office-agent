import type { PiCapacityLease, PiCapacityPolicy, PiKillSwitch, PiResilienceSnapshot, PiSecurityEvent } from "@/src/modules/pi-agent/domain/security-resilience-contracts";

export function presentKillSwitch(item: PiKillSwitch) {
  const { tenantId, activatedBy, releaseActorId, ...safe } = item;
  void tenantId; void activatedBy; void releaseActorId;
  return { ...safe, targetDigest: item.targetDigest ? `${item.targetDigest.slice(0, 12)}…` : undefined };
}

export function presentSecurityEvent(item: PiSecurityEvent) {
  const { tenantId, actorId, ...safe } = item;
  void tenantId; void actorId;
  return safe;
}

export function presentCapacityPolicy(item: PiCapacityPolicy) {
  const { tenantId, ...safe } = item;
  void tenantId;
  return safe;
}

export function presentCapacityLease(item: PiCapacityLease) {
  const { tenantId, actorId, ...safe } = item;
  void tenantId; void actorId;
  return safe;
}

export function presentResilience(snapshot: PiResilienceSnapshot) {
  return {
    killSwitches: snapshot.killSwitches.map(presentKillSwitch),
    securityEvents: snapshot.securityEvents,
    capacity: snapshot.capacity.map((item) => ({ policy: presentCapacityPolicy(item.policy), active: item.active })),
    faultsEnabled: snapshot.faultsEnabled,
    generatedAt: snapshot.generatedAt,
  };
}
