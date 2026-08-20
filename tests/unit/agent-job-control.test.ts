// Requirements: AR-009, AR-010, SR-001, SR-006, AC-004, AC-006, DR-008
import { describe, expect, it } from "vitest";
import { resolveAgentJobTransition } from "@/src/modules/agent/application/store";

describe("Agent job control state machine", () => {
  it("permits only evidence-safe manual state transitions", () => {
    expect(resolveAgentJobTransition("queued", "cancel")).toBe("cancelled");
    expect(resolveAgentJobTransition("retry_scheduled", "cancel")).toBe("cancelled");
    expect(resolveAgentJobTransition("unknown", "retry")).toBe("queued");
    expect(resolveAgentJobTransition("dead_letter", "retry")).toBe("queued");
    expect(resolveAgentJobTransition("unknown", "mark_succeeded")).toBe("succeeded");
    expect(resolveAgentJobTransition("unknown", "mark_failed")).toBe("failed");
    expect(resolveAgentJobTransition("unknown", "record_compensated")).toBe("compensated");
  });

  it("rejects cancellation during execution and any rewrite of a successful outcome", () => {
    expect(() => resolveAgentJobTransition("executing", "cancel")).toThrow("AGENT_JOB_STATE_CONFLICT");
    expect(() => resolveAgentJobTransition("succeeded", "retry")).toThrow("AGENT_JOB_STATE_CONFLICT");
    expect(() => resolveAgentJobTransition("cancelled", "mark_succeeded")).toThrow("AGENT_JOB_STATE_CONFLICT");
  });
});
