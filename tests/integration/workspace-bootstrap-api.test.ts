// Requirements: DR-010, FR-002
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/workspace/bootstrap/route";
import { DEMO_PROJECT_ID } from "@/src/platform/context/development-context";

describe("workspace bootstrap HTTP API", () => {
  it("returns authenticated development identity with an explicit fixture label", async () => {
    const response = await GET(new Request("http://localhost/api/v1/workspace/bootstrap", { headers: { "x-trace-id": "workspace-bootstrap-api" } }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data.identity.actorId).toBeTruthy();
    expect(payload.data.dataMode).toBe("development_fixture");
    expect(payload.data.projects.map((project: { id: string }) => project.id)).toContain(DEMO_PROJECT_ID);
    expect(payload.meta.traceId).toBe("workspace-bootstrap-api");
  });
});
