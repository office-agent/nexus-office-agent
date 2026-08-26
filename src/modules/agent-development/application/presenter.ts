import type { AgentDevelopmentProject } from "@/src/modules/agent-development/domain/contracts";

export function presentAgentDevelopmentProject(project: AgentDevelopmentProject) {
  return {
    id: project.id,
    code: project.code,
    name: project.name,
    owner: project.owner,
    objective: project.objective,
    scope: project.scope,
    nonGoals: project.nonGoals,
    acceptanceCriteria: project.acceptanceCriteria,
    status: project.status,
    inputDigest: project.inputDigest,
    version: project.version,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    documents: project.documents.map(({ id, kind, path, revision, content, digest, archivedAt }) => ({ id, kind, path, revision, content, digest, archivedAt })),
    versions: project.versions.map((item) => ({ id: item.id, projectId: item.projectId, name: item.name, fromCommit: item.fromCommit, toCommit: item.toCommit, diffDigest: item.diffDigest, diffExcerpt: item.diffContent.slice(0, 1_200), diffSize: item.diffContent.length, features: item.features, createdAt: item.createdAt })),
    tests: project.tests.map((item) => ({ id: item.id, projectId: item.projectId, versionId: item.versionId, name: item.name, cases: item.cases, result: item.result, evidence: item.evidence, evidenceDigest: item.evidenceDigest, createdAt: item.createdAt })),
    delivery: project.delivery ? { id: project.delivery.id, projectId: project.delivery.projectId, manifestDigest: project.delivery.manifestDigest, documentDigests: project.delivery.documentDigests, versionIds: project.delivery.versionIds, testIds: project.delivery.testIds, createdAt: project.delivery.createdAt } : undefined,
  };
}
