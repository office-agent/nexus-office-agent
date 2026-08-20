// Requirements: PR-005, PR-006, PR-009, MR-050, AR-012, SR-003, AC-007
import { describe, expect, it } from "vitest";
import { getAgentToolRegistry } from "@/src/modules/agent/runtime";
import { createDefaultSkillRegistry } from "@/src/modules/agent/domain/skill";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

describe("unified office Agent capability registry", () => {
  it("exposes enterprise read paths and durable memory through Skills instead of a keyword router", () => {
    const tools = getAgentToolRegistry().available(createDevelopmentRequestContext("office-tool-registry"));
    const ids = tools.map(({ id }) => id);
    expect(ids).toEqual(expect.arrayContaining([
      "memory.recall", "memory.remember", "office.read_governance_workspace", "office.read_enterprise_intelligence",
      "office.prepare_operating_insight", "knowledge.search", "meeting.prepare", "workflow.read_snapshot", "workflow.pre_review",
    ]));
    expect(ids).not.toContain("admin.assign_role");
    const skills = createDefaultSkillRegistry().list();
    expect(skills.find(({ id }) => id === "enterprise-memory")?.toolIds).toEqual(["memory.recall", "memory.remember"]);
    expect(skills.find(({ id }) => id === "meeting-preparation")?.toolIds).toContain("meeting.prepare");
    expect(skills.find(({ id }) => id === "process-assistance")?.toolIds).toContain("workflow.pre_review");
  });
});
