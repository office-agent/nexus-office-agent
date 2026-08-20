import { ManagementContextProvider } from "@/src/modules/agent/application/context-provider";
import { registerManagementTools } from "@/src/modules/agent/application/management-tools";
import { AgentOrchestrator } from "@/src/modules/agent/application/orchestrator";
import { InMemoryAgentStore } from "@/src/modules/agent/application/store";
import type { AgentStore } from "@/src/modules/agent/application/store";
import { PostgresAgentStore } from "@/src/modules/agent/infrastructure/postgres-agent-store";
import { OpenAICompatibleModelGateway, UnavailableModelGateway, type ModelGateway } from "@/src/modules/agent/domain/model-gateway";
import { ToolRegistry } from "@/src/modules/agent/domain/tool";
import { createDefaultSkillRegistry, type SkillRegistry } from "@/src/modules/agent/domain/skill";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { registerTaskCommandTools } from "@/src/modules/task-command/application/agent-tools";
import { registerWecomAccessControlTools, registerWecomApplicationMessageTools } from "@/src/modules/integration/application/wecom-agent-tools";
import { getWecomAccessControlService, getWecomApplicationMessageService } from "@/src/modules/integration/runtime";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { getAgentMemoryService } from "@/src/modules/agent-memory/runtime";
import { registerAgentMemoryTools } from "@/src/modules/agent-memory/application/agent-tools";
import { registerOfficeReadTools } from "@/src/modules/agent/application/office-read-tools";
import { getEnterpriseGovernanceService } from "@/src/modules/enterprise-governance/runtime";
import { getEnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/runtime";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";

const runtime = globalThis as typeof globalThis & {
  __nexusAgentRuntimeVersion?: number;
  __nexusAgentStore?: AgentStore;
  __nexusAgentOrchestrator?: AgentOrchestrator;
  __nexusAgentTools?: ToolRegistry;
  __nexusAgentSkills?: SkillRegistry;
};

export function createRuntimeModelGateway(): ModelGateway {
  if (process.env.NEXUS_MODEL_MODE === "disabled") return new UnavailableModelGateway();
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL;
  const model = process.env.OPENAI_MODEL || process.env.LLM_MODEL;
  return apiKey && baseUrl && model
    ? new OpenAICompatibleModelGateway(apiKey, baseUrl, model)
    : new UnavailableModelGateway();
}

export function getAgentOrchestrator(): AgentOrchestrator {
  if (runtime.__nexusAgentRuntimeVersion !== 9) {
    const management = getManagementLoopService();
    const taskCommand = getTaskCommandService();
    const memory = getAgentMemoryService();
    const tools = new ToolRegistry();
    registerManagementTools(tools, management);
    registerAgentMemoryTools(tools, memory);
    const governanceWorkspace = getGovernanceRuntime();
    registerOfficeReadTools(tools, {
      governance: getEnterpriseGovernanceService(), intelligence: getEnterpriseIntelligenceService(),
      knowledge: governanceWorkspace.knowledge, meetings: governanceWorkspace.meetings, workflow: governanceWorkspace.workflow,
    });
    registerTaskCommandTools(tools, taskCommand);
    registerWecomAccessControlTools(tools, getWecomAccessControlService());
    registerWecomApplicationMessageTools(tools, getWecomApplicationMessageService());
    const skills = createDefaultSkillRegistry();
    runtime.__nexusAgentStore = process.env.DATABASE_URL
      ? new PostgresAgentStore(createPostgresDatabase(process.env.DATABASE_URL))
      : new InMemoryAgentStore();
    runtime.__nexusAgentTools = tools;
    runtime.__nexusAgentSkills = skills;
    runtime.__nexusAgentOrchestrator = new AgentOrchestrator(
      runtime.__nexusAgentStore,
      new ManagementContextProvider(management, taskCommand, memory),
      createRuntimeModelGateway(),
      tools,
      skills,
      taskCommand,
      memory,
    );
    runtime.__nexusAgentRuntimeVersion = 9;
  }
  return runtime.__nexusAgentOrchestrator!;
}

export function getAgentToolRegistry(): ToolRegistry {
  getAgentOrchestrator();
  return runtime.__nexusAgentTools!;
}
