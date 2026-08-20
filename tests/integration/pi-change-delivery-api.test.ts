// Requirements: PR-010, PR-011, SR-006, SR-007, AC-011, AC-012, DR-011, DR-012
import { describe, expect, it } from "vitest";
import { POST as submitChange } from "@/app/api/v1/pi/sessions/[id]/submit-change/route";
import { GET as getChangeDelivery } from "@/app/api/v1/pi/admin/change-delivery/route";

const SESSION_ID = "76000000-0000-4000-8000-000000000003";

describe("Pi Change Delivery HTTP boundary", () => {
  it("rejects a mutating submission without an idempotency key before parsing or execution", async () => {
    const response = await submitChange(
      new Request("http://localhost/api/v1/pi/sessions/76000000-0000-4000-8000-000000000003/submit-change", {
        method: "POST",
        headers: { "content-type": "application/json", "x-trace-id": "api-change-missing-key" },
        body: "not-json",
      }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("PI_IDEMPOTENCY_KEY_REQUIRED");
  });

  it("returns a structured validation error for malformed submission input", async () => {
    const response = await submitChange(
      new Request("http://localhost/api/v1/pi/sessions/76000000-0000-4000-8000-000000000003/submit-change", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "api-change-invalid", "x-trace-id": "api-change-invalid" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("exposes only safe change delivery facts in the admin snapshot", async () => {
    const response = await getChangeDelivery(new Request("http://localhost/api/v1/pi/admin/change-delivery", { headers: { "x-trace-id": "api-change-snapshot" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(expect.objectContaining({ submissions: expect.any(Array), pullRequests: expect.any(Array), outbox: expect.any(Array) }));
    expect(JSON.stringify(body).toLowerCase()).not.toContain("secret");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("credential");
  });
});
