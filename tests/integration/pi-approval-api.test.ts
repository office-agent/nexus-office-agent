// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { describe, expect, it } from "vitest";
import { GET as listApprovals } from "@/app/api/v1/pi/approvals/route";
import { POST as decideApproval } from "@/app/api/v1/pi/approvals/[approvalId]/decisions/route";

describe("Pi approval HTTP boundary", () => {
  it("lists only the development tenant approval view and never exposes a secret or execution handle", async () => {
    const response = await listApprovals(new Request("http://localhost/api/v1/pi/approvals", { headers: { "x-trace-id": "approval-http-list" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("credential");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("requires an idempotency key before accepting an approval decision", async () => {
    const response = await decideApproval(
      new Request("http://localhost/api/v1/pi/approvals/71000000-0000-4000-8000-000000000101/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalHash: "a".repeat(64), decision: "approve" }),
      }),
      { params: Promise.resolve({ approvalId: "71000000-0000-4000-8000-000000000101" }) },
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("PI_IDEMPOTENCY_KEY_REQUIRED");
  });
});
