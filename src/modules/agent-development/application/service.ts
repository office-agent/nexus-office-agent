import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type {
  AgentDevelopmentDelivery,
  AgentDevelopmentFunctionalTest,
  AgentDevelopmentProject,
  AgentDevelopmentProjectSeed,
  AgentDevelopmentSkillRecommendation,
  AgentDevelopmentStatus,
  AgentDevelopmentStore,
  AgentDevelopmentVersion,
  ProjectToActDocument,
  ProjectToActDocumentKind,
} from "@/src/modules/agent-development/domain/contracts";

type HandoffInput = { code: string; name: string; owner: string; objective: string; scope: string[]; nonGoals: string[]; acceptanceCriteria: string[] };
type VersionInput = { projectVersion: number; name: string; fromCommit: string; toCommit: string; diffContent: string; features: string[] };
type FunctionalTestInput = { projectVersion: number; versionId: string; name: string; cases: string[]; result: "passed" | "failed"; evidence: string };

const DOCUMENT_PATHS: Record<ProjectToActDocumentKind, string> = {
  overview: ".project-to-act/PROJECT_OVERVIEW.md",
  progress: ".project-to-act/PROJECT_PROGRESS.md",
  features: ".project-to-act/PROJECT_FEATURES.md",
  versions: ".project-to-act/PROJECT_VERSIONS.md",
  acceptance: ".project-to-act/PROJECT_ACCEPTANCE.md",
};

export const AGENT_DEVELOPMENT_SKILLS: AgentDevelopmentSkillRecommendation[] = [
  { name: "project-to-act", stage: "handoff", purpose: "建立唯一项目事实源，维护目标、进度、功能、版本与验收文档。", required: true },
  { name: "repo-task-sync", stage: "development", purpose: "多人和多个编码 Agent 顺序协作时同步任务、分支、PR 与交接状态。", required: false },
  { name: "llm-api-config", stage: "development", purpose: "项目接入模型 API、模型名称或密钥配置时使用受控配置档，避免泄密。", required: false },
  { name: "ui-design", stage: "development", purpose: "涉及页面或交互时建立明确视觉方向，并完成桌面与移动端实现。", required: false },
  { name: "aawo-agent-tester", stage: "testing", purpose: "按真实客户旅程测试 Agent 边界、失败关闭、证据与副作用门禁。", required: false },
  { name: "agentops-awesome-list", stage: "testing", purpose: "在交付前按实际复杂度执行只读健康检查，识别架构缺口、功能风险与优化建议；不修改项目或替代功能测试。", required: false },
  { name: "avoid-overkill", stage: "throughout", purpose: "控制实现和验证强度，避免偏离交付目标或堆砌无关防护。", required: false },
];

function digest(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function lines(items: string[]): string { return items.length ? items.map((item) => `- ${item}`).join("\n") : "- 无"; }
function stageLabel(status: AgentDevelopmentStatus): string {
  return { requirements_archived: "需求已归档", in_development: "开发中", testing: "功能测试中", ready_to_deliver: "可交付", delivered: "已交付" }[status];
}

function assertPermission(context: RequestContext, permission: "agent_development:read" | "agent_development:write" | "agent_development:deliver") {
  if (!context.permissions.includes(permission)) throw new Error("ACCESS_DENIED");
}

function currentRevision(project: Pick<AgentDevelopmentProject, "documents"> | undefined): number {
  return project?.documents.reduce((maximum, item) => Math.max(maximum, item.revision), 0) ?? 0;
}

function documentContents(input: {
  project: Pick<AgentDevelopmentProject, "code" | "name" | "owner" | "objective" | "scope" | "nonGoals" | "acceptanceCriteria">;
  status: AgentDevelopmentStatus;
  versions: AgentDevelopmentVersion[];
  tests: AgentDevelopmentFunctionalTest[];
  delivery?: AgentDevelopmentDelivery;
}): Record<ProjectToActDocumentKind, string> {
  const { project, status, versions, tests, delivery } = input;
  const versionSections = versions.length ? versions.map((item) => `## ${item.name}\n\n- Commit：\`${item.fromCommit}\` → \`${item.toCommit}\`\n- Diff SHA-256：\`${item.diffDigest}\`\n- 功能：\n${lines(item.features)}`).join("\n\n") : "尚未登记主要版本。";
  const featureItems = versions.length ? versions.flatMap((item) => item.features.map((feature) => `- [${item.name}] ${feature}`)).join("\n") : lines(project.acceptanceCriteria);
  const testSections = versions.length ? versions.map((version) => {
    const related = tests.filter((item) => item.versionId === version.id);
    return `## ${version.name}\n\n${related.length ? related.map((item) => `- ${item.result === "passed" ? "[x]" : "[ ]"} ${item.name} · ${item.cases.length} 项用例 · 证据 \`${item.evidenceDigest}\``).join("\n") : "- [ ] 尚无功能测试证据"}`;
  }).join("\n\n") : "尚无可测试版本。";
  return {
    overview: `# 项目总览\n\n- 项目：${project.code} · ${project.name}\n- 负责人：${project.owner}\n- 当前阶段：${stageLabel(status)}\n\n## 目标\n\n${project.objective}\n\n## 范围\n\n${lines(project.scope)}\n\n## 非目标\n\n${lines(project.nonGoals)}`,
    progress: `# 项目进度\n\n- 当前阶段：${stageLabel(status)}\n- 需求归档：已完成\n- 主要版本：${versions.length} 个\n- 功能测试：${tests.length} 条，其中 ${tests.filter((item) => item.result === "passed").length} 条通过\n- 交付清单：${delivery ? "已生成并冻结" : "未生成"}\n\n## 下一道门禁\n\n${status === "requirements_archived" ? "登记首个主要版本的 Diff 与功能清单。" : status === "in_development" || status === "testing" ? "确保每个主要版本均有通过的功能测试。" : status === "ready_to_deliver" ? "复核五文档、全部版本和测试后生成交付清单。" : "交付事实已冻结；后续变化必须进入新的主要版本。"}`,
    features: `# 项目功能\n\n## 需求验收基线\n\n${lines(project.acceptanceCriteria)}\n\n## 已登记功能\n\n${featureItems}`,
    versions: `# 项目版本\n\n${versionSections}`,
    acceptance: `# 项目验收\n\n## 验收标准\n\n${lines(project.acceptanceCriteria)}\n\n## 逐版本功能测试\n\n${testSections}\n\n## 交付门禁\n\n- [x] 需求已转化并归档为五类 project-to-act 文档\n- [${versions.length ? "x" : " "}] 至少登记一个主要版本\n- [${versions.length > 0 && versions.every((version) => tests.some((test) => test.versionId === version.id && test.result === "passed")) ? "x" : " "}] 每个主要版本均有通过的功能测试\n- [${delivery ? "x" : " "}] 已生成包含文档、版本和测试摘要的交付清单`,
  };
}

function buildDocuments(projectId: string, input: Parameters<typeof documentContents>[0], previous?: Pick<AgentDevelopmentProject, "documents">, timestamp = new Date().toISOString()): ProjectToActDocument[] {
  const contents = documentContents(input);
  const revision = currentRevision(previous) + 1;
  return (Object.keys(DOCUMENT_PATHS) as ProjectToActDocumentKind[]).map((kind) => ({
    id: randomUUID(), projectId, kind, path: DOCUMENT_PATHS[kind], revision, content: contents[kind], digest: digest(contents[kind]), archivedAt: timestamp,
  }));
}

function statusAfterTest(versions: AgentDevelopmentVersion[], tests: AgentDevelopmentFunctionalTest[]): AgentDevelopmentStatus {
  if (!versions.length) return "requirements_archived";
  if (!tests.length) return "in_development";
  return versions.every((version) => tests.some((test) => test.versionId === version.id && test.result === "passed")) ? "ready_to_deliver" : "testing";
}

export class AgentDevelopmentService {
  constructor(private readonly store: AgentDevelopmentStore) {}

  async snapshot(context: RequestContext) {
    assertPermission(context, "agent_development:read");
    return { projects: await this.store.list(context), skills: AGENT_DEVELOPMENT_SKILLS, generatedAt: new Date().toISOString() };
  }

  async handoff(context: RequestContext, input: HandoffInput, idempotencyKey: string): Promise<AgentDevelopmentProject> {
    assertPermission(context, "agent_development:write");
    const inputDigest = digest(input);
    const existing = await this.store.findProjectByIdempotency(context, idempotencyKey);
    if (existing) {
      if (existing.inputDigest !== inputDigest || existing.createdBy !== context.actorId) throw new Error("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
      return existing;
    }
    const timestamp = new Date().toISOString();
    const seed: AgentDevelopmentProjectSeed = {
      id: randomUUID(), tenantId: context.tenantId, createdBy: context.actorId, code: input.code, name: input.name, owner: input.owner,
      objective: input.objective, scope: [...input.scope], nonGoals: [...input.nonGoals], acceptanceCriteria: [...input.acceptanceCriteria],
      status: "requirements_archived", inputDigest, version: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    const documents = buildDocuments(seed.id, { project: seed, status: seed.status, versions: [], tests: [] }, undefined, timestamp);
    const result = await this.store.create(context, seed, documents, idempotencyKey);
    if (!result.created && (result.project.inputDigest !== inputDigest || result.project.createdBy !== context.actorId)) throw new Error("AGENT_DEVELOPMENT_IDEMPOTENCY_CONFLICT");
    if (result.project.documents.length !== 5) throw new Error("AGENT_DEVELOPMENT_ARCHIVE_INCOMPLETE");
    return result.project;
  }

  async recordVersion(context: RequestContext, projectId: string, input: VersionInput, idempotencyKey: string): Promise<AgentDevelopmentProject> {
    assertPermission(context, "agent_development:write");
    const project = await this.requireProject(context, projectId);
    if (project.documents.length !== 5) throw new Error("AGENT_DEVELOPMENT_REQUIREMENT_ARCHIVE_REQUIRED");
    if (project.status === "delivered") throw new Error("AGENT_DEVELOPMENT_ALREADY_DELIVERED");
    const timestamp = new Date().toISOString();
    const item: AgentDevelopmentVersion = {
      id: randomUUID(), projectId, name: input.name, fromCommit: input.fromCommit.toLowerCase(), toCommit: input.toCommit.toLowerCase(),
      diffContent: input.diffContent, diffDigest: digest(input.diffContent), features: [...input.features], createdBy: context.actorId, createdAt: timestamp,
    };
    const versions = [...project.versions, item];
    const status: AgentDevelopmentStatus = "in_development";
    const documents = buildDocuments(projectId, { project, status, versions, tests: project.tests }, project, timestamp);
    return this.store.appendVersion(context, projectId, input.projectVersion, item, documents, idempotencyKey, status);
  }

  async recordTest(context: RequestContext, projectId: string, input: FunctionalTestInput, idempotencyKey: string): Promise<AgentDevelopmentProject> {
    assertPermission(context, "agent_development:write");
    const project = await this.requireProject(context, projectId);
    if (project.status === "requirements_archived") throw new Error("AGENT_DEVELOPMENT_VERSION_REQUIRED");
    if (project.status === "delivered") throw new Error("AGENT_DEVELOPMENT_ALREADY_DELIVERED");
    if (!project.versions.some((item) => item.id === input.versionId)) throw new Error("AGENT_DEVELOPMENT_VERSION_NOT_FOUND");
    const timestamp = new Date().toISOString();
    const item: AgentDevelopmentFunctionalTest = {
      id: randomUUID(), projectId, versionId: input.versionId, name: input.name, cases: [...input.cases], result: input.result, evidence: input.evidence,
      evidenceDigest: digest({ name: input.name, cases: input.cases, result: input.result, evidence: input.evidence }), createdBy: context.actorId, createdAt: timestamp,
    };
    const tests = [...project.tests, item];
    const status = statusAfterTest(project.versions, tests);
    const documents = buildDocuments(projectId, { project, status, versions: project.versions, tests }, project, timestamp);
    return this.store.appendTest(context, projectId, input.projectVersion, item, documents, idempotencyKey, status);
  }

  async deliver(context: RequestContext, projectId: string, projectVersion: number, idempotencyKey: string): Promise<AgentDevelopmentProject> {
    assertPermission(context, "agent_development:deliver");
    const project = await this.requireProject(context, projectId);
    if (project.delivery) return project;
    if (project.documents.length !== 5) throw new Error("AGENT_DEVELOPMENT_ARCHIVE_INCOMPLETE");
    if (!project.versions.length) throw new Error("AGENT_DEVELOPMENT_VERSION_REQUIRED");
    if (project.versions.some((item) => !item.diffContent || !item.diffDigest || !item.features.length)) throw new Error("AGENT_DEVELOPMENT_VERSION_EVIDENCE_REQUIRED");
    const passingTests = project.tests.filter((item) => item.result === "passed");
    if (!project.versions.every((version) => passingTests.some((test) => test.versionId === version.id))) throw new Error("AGENT_DEVELOPMENT_TEST_GATE_REQUIRED");
    const timestamp = new Date().toISOString();
    const provisional: AgentDevelopmentDelivery = { id: randomUUID(), projectId, manifestDigest: "", documentDigests: { overview: "", progress: "", features: "", versions: "", acceptance: "" }, versionIds: project.versions.map(({ id }) => id), testIds: passingTests.map(({ id }) => id), createdBy: context.actorId, createdAt: timestamp };
    const finalDocuments = buildDocuments(projectId, { project, status: "delivered", versions: project.versions, tests: project.tests, delivery: provisional }, project, timestamp);
    provisional.documentDigests = Object.fromEntries(finalDocuments.map((item) => [item.kind, item.digest])) as AgentDevelopmentDelivery["documentDigests"];
    provisional.manifestDigest = digest({ documents: provisional.documentDigests, versions: project.versions.map((item) => ({ id: item.id, name: item.name, diffDigest: item.diffDigest, features: item.features })), tests: passingTests.map((item) => ({ id: item.id, versionId: item.versionId, evidenceDigest: item.evidenceDigest })) });
    return this.store.createDelivery(context, projectId, projectVersion, provisional, finalDocuments, idempotencyKey);
  }

  private async requireProject(context: RequestContext, projectId: string): Promise<AgentDevelopmentProject> {
    const project = await this.store.find(context, projectId);
    if (!project) throw new Error("AGENT_DEVELOPMENT_PROJECT_NOT_FOUND");
    return project;
  }
}
