// Requirements: DR-010, FR-002, NFR-002
import { describe, expect, it } from "vitest";
import { WorkspaceBootstrapService } from "@/src/modules/workspace-bootstrap/application/service";
import type { WorkspaceBootstrapRepository } from "@/src/modules/workspace-bootstrap/application/contracts";
import type { RequestContext } from "@/src/platform/context/request-context";

const tenantId = "00000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000001";
const ownedProjectId = "30000000-0000-4000-8000-000000000001";
const hiddenProjectId = "30000000-0000-4000-8000-000000000002";

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId,
    actorId,
    sessionId: "session",
    channel: "web",
    traceId: "workspace-bootstrap-test",
    roles: ["project_manager"],
    permissions: ["project:read"],
    dataScopes: [{ type: "owned" }],
    ...overrides,
  };
}

function repository(): WorkspaceBootstrapRepository {
  return {
    async getIdentity() {
      return { tenantId, tenantName: "测试租户", actorId, displayName: "测试用户" };
    },
    async listProjects() {
      return [
        { id: hiddenProjectId, code: "HIDDEN", name: "无权项目", ownerId: "10000000-0000-4000-8000-000000000002", status: "active", priority: "high", health: "at_risk", targetEndAt: "2026-09-01" },
        { id: ownedProjectId, code: "OWNED", name: "负责项目", ownerId: actorId, status: "active", priority: "high", health: "watch", targetEndAt: "2026-09-01" },
      ];
    },
  };
}

describe("workspace bootstrap", () => {
  it("returns identity and only projects allowed by the current data scope", async () => {
    const result = await new WorkspaceBootstrapService(repository(), "production").bootstrap(context());
    expect(result.identity).toMatchObject({ tenantId, actorId, displayName: "测试用户" });
    expect(result.projects.map(({ id }) => id)).toEqual([ownedProjectId]);
    expect(result.selectedProjectId).toBe(ownedProjectId);
    expect(result.dataMode).toBe("production");
  });

  it("returns an honest empty project directory when permission is missing", async () => {
    const result = await new WorkspaceBootstrapService(repository(), "production").bootstrap(context({ permissions: [] }));
    expect(result.projects).toEqual([]);
    expect(result.selectedProjectId).toBeNull();
  });
});
