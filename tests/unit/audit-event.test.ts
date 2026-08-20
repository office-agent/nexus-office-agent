// Requirements: AR-004, AR-005, SR-005, AC-008
import { describe, expect, it } from "vitest";
import { createAuditEvent, digestValue, redactSensitive } from "@/src/modules/audit/domain/audit-event";

describe("audit event", () => {
  it("redacts nested credential-like fields", () => {
    const redacted = redactSensitive({
      authorization: "Bearer hidden",
      nested: { apiKey: "hidden", safe: "visible" },
      items: [{ access_token: "hidden" }],
    });
    expect(redacted).toEqual({
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "visible" },
      items: [{ access_token: "[REDACTED]" }],
    });
  });

  it("produces a stable digest independent of object key order", () => {
    expect(digestValue({ b: 2, a: 1 })).toBe(digestValue({ a: 1, b: 2 }));
  });

  it("creates an append-only shaped event without preserving secrets", () => {
    const event = createAuditEvent({
      tenantId: "tenant-a",
      actorType: "user",
      actorId: "user-1",
      channel: "web",
      traceId: "trace-1",
      action: "project.update",
      resourceType: "project",
      resourceId: "project-1",
      decision: "executed",
      metadata: { token: "hidden", status: "active" },
    });
    expect(event.id).toBeTruthy();
    expect(event.metadata).toEqual({ token: "[REDACTED]", status: "active" });
  });
});
