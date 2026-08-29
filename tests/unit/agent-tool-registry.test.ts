// Requirements: PR-005, PR-006, PR-009, SR-003, SR-006, AC-006, AC-007
import { describe, expect, it } from "vitest";
import { modelToolName, ToolRegistry, type AgentTool } from "@/src/modules/agent/domain/tool";

function makeTool(id: string): AgentTool {
  return {
    id,
    skillId: "test-skill",
    version: 1,
    description: id,
    requiredPermissions: [],
    riskLevel: 0,
    confirmationPolicy: "never",
    sideEffect: "none",
    timeoutMs: 1_000,
    maxAttempts: 1,
    allowedChannels: ["web"],
    inputJsonSchema: { type: "object" },
    inputSchema: { parse: (input: unknown) => input },
    preview: () => "",
    execute: async () => ({}),
  };
}

describe("Agent ToolRegistry routing safety", () => {
  it("rejects registering a tool whose model name collides with an existing tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("work.create_task_template"));
    expect(() => registry.register(makeTool("work/create_task_template"))).toThrow("TOOL_MODEL_NAME_COLLISION");
  });

  it("resolves distinct model names to the exact registered tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("management.create_risk"));
    registry.register(makeTool("admin.assign_role"));
    expect(registry.getByModelName(modelToolName("management.create_risk")).id).toBe("management.create_risk");
    expect(registry.getByModelName(modelToolName("admin.assign_role")).id).toBe("admin.assign_role");
  });

  it("still rejects duplicate tool ids before the model-name check", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("work.create_task_template"));
    expect(() => registry.register(makeTool("work.create_task_template"))).toThrow("TOOL_ALREADY_REGISTERED");
  });
});
