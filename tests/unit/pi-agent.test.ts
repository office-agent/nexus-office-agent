// Requirements: PR-008, PR-009, SR-001, SR-003, SR-004, SR-006, AC-006, AC-008
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiToolAllowed } from "@/src/modules/pi-agent/application/policy";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { createPiWorkspaceTools } from "@/src/modules/pi-agent/infrastructure/tools";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";

const context = (tenantId = "tenant-a", actorId = "actor-a"): RequestContext => ({
  tenantId, actorId, sessionId: "session", channel: "web", traceId: "trace", roles: [],
  permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute"], dataScopes: [{ type: "tenant" }],
});

describe("Pi enterprise runtime boundaries", () => {
  it("rejects write tools for the review profile", () => {
    expect(() => assertPiToolAllowed("review", "workspace_write", context())).toThrow("PI_TOOL_NOT_ALLOWED");
  });

  it("keeps virtual workspace paths inside the sandbox and never executes host commands", async () => {
    const provider = new VirtualSandboxProvider();
    const sandbox = await provider.create({ tenantId: "tenant-a", actorId: "actor-a", sessionId: "pi", workspaceId: "workspace", profile: "coding", networkPolicy: "none" });
    await provider.write(sandbox, "src/app.ts", "export const answer = 41;");
    await expect(provider.read(sandbox, "../outside.txt")).rejects.toThrow("PI_SANDBOX_PATH_INVALID");
    const result = await provider.run();
    expect(result).toMatchObject({ ok: false, errorCode: "PI_SANDBOX_EXECUTION_DISABLED" });
  });

  it("exposes only policy-approved workspace tools to Pi", async () => {
    const provider = new VirtualSandboxProvider();
    const sandbox = await provider.create({ tenantId: "tenant-a", actorId: "actor-a", sessionId: "pi", workspaceId: "workspace", profile: "coding", networkPolicy: "none" });
    const tools = createPiWorkspaceTools({ context: context(), profile: "coding", sandbox, provider });
    const write = tools.find((tool) => tool.name === "workspace_write");
    const read = tools.find((tool) => tool.name === "workspace_read");
    expect(write).toBeDefined();
    expect(read).toBeDefined();
    await write!.execute("call-1", { path: "README.md", content: "hello" }, undefined, undefined, {} as never);
    const result = await read!.execute("call-2", { path: "README.md" }, undefined, undefined, {} as never);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect("text" in result.content[0] ? result.content[0].text : "").toContain("hello");
  });

  it("does not leak sessions across tenants", async () => {
    const store = new InMemoryPiSessionStore();
    const service = new PiAgentService(store, new VirtualSandboxProvider());
    const created = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-a" });
    await expect(service.getSession(context("tenant-b", "actor-a"), created.id)).rejects.toThrow("PI_SESSION_NOT_FOUND");
    expect((await service.listSessions(context())).map((item) => item.id)).toEqual([created.id]);
  });

  it("fails closed before creating a production Session without a micro VM provider", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const service = new PiAgentService(new InMemoryPiSessionStore(), new VirtualSandboxProvider());
      await expect(service.createSession(context(), { profile: "coding", workspaceId: "workspace" })).rejects.toThrow("PI_SANDBOX_RUNTIME_NOT_READY");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
