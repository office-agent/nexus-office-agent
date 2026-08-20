// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { describe, expect, it } from "vitest";
import { GET as getOverview } from "@/app/api/v1/pi/admin/overview/route";
import { POST as publishSkill } from "@/app/api/v1/pi/admin/resources/skills/route";

describe("Pi governance HTTP boundary", () => {
  it("returns a tenant-scoped, secret-free governance snapshot", async () => {
    const response = await getOverview(new Request("http://localhost/api/v1/pi/admin/overview", { headers: { "x-trace-id": "pi-governance-overview" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.profiles).toHaveLength(7);
    expect(body.data.capabilities.canManageMcp).toBe(true);
    expect(body.data.resources).toEqual({ skills: [], artifacts: [] });
    expect(body.data.mcp).toEqual({ servers: [], bindings: [] });
    expect(JSON.stringify(body)).not.toContain("signature");
    expect(JSON.stringify(body)).not.toContain("credential");
    expect(JSON.stringify(body)).not.toContain("endpointRef");
  });

  it("requires an idempotency key before accepting a Skill release draft", async () => {
    const response = await publishSkill(new Request("http://localhost/api/v1/pi/admin/resources/skills", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace-id": "pi-governance-publish" },
      body: JSON.stringify({
        skillId: "review-helper",
        version: "1.0.0",
        scope: "tenant",
        signature: "signature",
        content: "---\nname: review-helper\ndescription: review\n---\nReview code.",
        requiredTools: ["workspace_read"],
        dataClassification: "internal",
        riskLevel: "R0",
        allowedProfiles: ["review"],
      }),
    }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("PI_IDEMPOTENCY_KEY_REQUIRED");
  });
});
