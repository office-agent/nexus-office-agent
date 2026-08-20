import type { PiRunStatus } from "@/src/modules/pi-agent/domain/contracts";

const transitions: Record<PiRunStatus, readonly PiRunStatus[]> = {
  queued: ["provisioning", "queued", "running", "awaiting_approval", "cancelling", "cancelled", "failed", "timed_out", "unknown"],
  provisioning: ["provisioning", "running", "awaiting_approval", "completed", "cancelling", "cancelled", "failed", "timed_out", "queued", "unknown"],
  running: ["running", "awaiting_approval", "completed", "cancelling", "cancelled", "failed", "timed_out", "queued", "unknown"],
  awaiting_approval: ["awaiting_approval", "running", "cancelling", "cancelled", "unknown"],
  cancelling: ["cancelling", "cancelled", "unknown"],
  completed: ["completed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
  timed_out: ["timed_out"],
  unknown: ["unknown"],
};

export function isPiRunStatusTransitionAllowed(from: PiRunStatus, to: PiRunStatus): boolean {
  return transitions[from].includes(to);
}
