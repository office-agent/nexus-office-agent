import type { TaskCommandRepository } from "@/src/modules/task-command/application/contracts";
import { createWorkConversation, type WorkArtifact, type WorkArtifactVersion, type WorkConversation, type WorkConversationMessage, type WorkMessageEvent, type WorkMission, type WorkOrgUnit, type WorkPackage, type WorkPerson, type WorkPoolFeedback, type WorkPoolMessage, type WorkTaskEvent, type WorkTaskHandoff } from "@/src/modules/task-command/domain/task-command";
import { DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

export const DEMO_DELIVERY_OWNER_ID = "10000000-0000-4000-8000-000000000002";
export const DEMO_PRODUCT_OWNER_ID = "10000000-0000-4000-8000-000000000003";
export const DEMO_OPERATIONS_OWNER_ID = "10000000-0000-4000-8000-000000000004";
export const DEMO_MANAGEMENT_ORG_ID = "20000000-0000-4000-8000-000000000001";
export const DEMO_DELIVERY_ORG_ID = "20000000-0000-4000-8000-000000000002";
export const DEMO_PRODUCT_ORG_ID = "20000000-0000-4000-8000-000000000003";
export const DEMO_OPERATIONS_ORG_ID = "20000000-0000-4000-8000-000000000004";

export class InMemoryTaskCommandRepository implements TaskCommandRepository {
  private readonly conversations = new Map<string, WorkConversation>();
  private readonly messages: WorkConversationMessage[] = [];
  private readonly missions: WorkMission[] = [];
  private readonly packages: WorkPackage[] = [];
  private readonly events: WorkTaskEvent[] = [];
  private readonly handoffs: WorkTaskHandoff[] = [];
  private readonly artifacts = new Map<string, WorkArtifact>();
  private readonly artifactVersions: WorkArtifactVersion[] = [];
  private readonly poolMessages: WorkPoolMessage[] = [];
  private readonly poolFeedback: WorkPoolFeedback[] = [];
  private readonly messageEvents: WorkMessageEvent[] = [];
  private sequence = 0;
  private messageSequence = 0;
  private readonly orgUnits: WorkOrgUnit[] = [
    { id: DEMO_MANAGEMENT_ORG_ID, name: "经营管理" },
    { id: DEMO_DELIVERY_ORG_ID, name: "交付中心" },
    { id: DEMO_PRODUCT_ORG_ID, name: "产品中心" },
    { id: DEMO_OPERATIONS_ORG_ID, name: "运营中心" },
  ];
  private readonly people: WorkPerson[] = [
    { id: DEMO_MANAGER_ID, displayName: "开发管理员", orgUnitId: DEMO_MANAGEMENT_ORG_ID, orgName: "经营管理", positionName: "企业负责人", activeTaskCount: 0 },
    { id: DEMO_DELIVERY_OWNER_ID, displayName: "周然", orgUnitId: DEMO_DELIVERY_ORG_ID, orgName: "交付中心", positionName: "交付负责人", activeTaskCount: 0 },
    { id: DEMO_PRODUCT_OWNER_ID, displayName: "林悦", orgUnitId: DEMO_PRODUCT_ORG_ID, orgName: "产品中心", positionName: "产品负责人", activeTaskCount: 0 },
    { id: DEMO_OPERATIONS_OWNER_ID, displayName: "陈屿", orgUnitId: DEMO_OPERATIONS_ORG_ID, orgName: "运营中心", positionName: "运营负责人", activeTaskCount: 0 },
  ];

  async getOrCreatePrimaryConversation(tenantId: string, ownerId: string) {
    const key = `${tenantId}:${ownerId}`;
    let value = this.conversations.get(key);
    if (!value) {
      value = createWorkConversation(tenantId, ownerId);
      this.conversations.set(key, structuredClone(value));
    }
    return structuredClone(value);
  }

  async appendMessage(message: WorkConversationMessage) {
    if (message.runId && this.messages.some((item) => item.tenantId === message.tenantId && item.runId === message.runId && item.role === message.role)) return;
    this.messages.push(structuredClone(message));
  }

  async listMessages(tenantId: string, conversationId: string, limit: number) {
    return structuredClone(this.messages.filter((item) => item.tenantId === tenantId && item.conversationId === conversationId).slice(-limit));
  }

  async listPeople(tenantId: string) {
    if (tenantId !== DEMO_TENANT_ID) return [];
    return structuredClone(this.people.map((person) => ({ ...person, activeTaskCount: this.packages.filter((item) => item.tenantId === tenantId && item.assigneeId === person.id && !["completed", "cancelled"].includes(item.status)).length })));
  }

  async listOrgUnits(tenantId: string) { return tenantId === DEMO_TENANT_ID ? structuredClone(this.orgUnits) : []; }

  async listMissions(tenantId: string) { return structuredClone(this.missions.filter((item) => item.tenantId === tenantId)); }
  async listPackages(tenantId: string) { return structuredClone(this.packages.filter((item) => item.tenantId === tenantId)); }
  async getPackage(tenantId: string, id: string) { return structuredClone(this.packages.find((item) => item.tenantId === tenantId && item.id === id) ?? null); }

  async publishMission(mission: WorkMission, packages: WorkPackage[], events: Omit<WorkTaskEvent, "sequence">[]) {
    const existing = mission.sourceRunId ? this.missions.find((item) => item.tenantId === mission.tenantId && item.sourceRunId === mission.sourceRunId) : undefined;
    if (existing) return { mission: structuredClone(existing), packages: structuredClone(this.packages.filter((item) => item.missionId === existing.id)), created: false };
    this.missions.push(structuredClone(mission));
    this.packages.push(...structuredClone(packages));
    for (const item of events) this.events.push({ ...structuredClone(item), sequence: ++this.sequence });
    return { mission: structuredClone(mission), packages: structuredClone(packages), created: true };
  }

  async updateTaskTemplate(input: { currentMission: WorkMission; nextMission: WorkMission; currentPackage: WorkPackage; nextPackage: WorkPackage; expectedVersion: number; event: Omit<WorkTaskEvent, "sequence"> }) {
    const missionIndex = this.missions.findIndex((item) => item.tenantId === input.currentMission.tenantId && item.id === input.currentMission.id && item.version === input.currentMission.version && item.isTemplate);
    const packageIndex = this.packages.findIndex((item) => item.tenantId === input.currentPackage.tenantId && item.id === input.currentPackage.id && item.version === input.expectedVersion && item.isTemplate);
    if (missionIndex < 0 || packageIndex < 0) return false;
    this.missions[missionIndex] = structuredClone(input.nextMission);
    this.packages[packageIndex] = structuredClone(input.nextPackage);
    this.events.push({ ...structuredClone(input.event), sequence: ++this.sequence });
    return true;
  }

  async claimPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number }) {
    return this.updatePackage(input.current, input.next, input.expectedVersion, input.event);
  }

  async transitionPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number }) {
    return this.updatePackage(input.current, input.next, input.expectedVersion, input.event);
  }

  async listEvents(tenantId: string, actorId: string, after: number, limit: number) {
    void actorId;
    return structuredClone(this.events.filter((item) => item.tenantId === tenantId && item.sequence > after).slice(0, limit));
  }

  async listHandoffs(tenantId: string, packageIds: string[]) {
    const ids = new Set(packageIds);
    return structuredClone(this.handoffs.filter((item) => item.tenantId === tenantId && ids.has(item.packageId)).sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  async getHandoff(tenantId: string, id: string) {
    return structuredClone(this.handoffs.find((item) => item.tenantId === tenantId && item.id === id) ?? null);
  }

  async createArtifact(artifact: WorkArtifact, initialVersion: WorkArtifactVersion) {
    if (this.artifacts.has(`${artifact.tenantId}:${artifact.id}`)) throw new Error("WORK_ARTIFACT_CONFLICT");
    this.artifacts.set(`${artifact.tenantId}:${artifact.id}`, structuredClone(artifact));
    this.artifactVersions.push(structuredClone(initialVersion));
    return structuredClone(artifact);
  }

  async getArtifact(tenantId: string, id: string) {
    return structuredClone(this.artifacts.get(`${tenantId}:${id}`) ?? null);
  }

  async getArtifactVersions(tenantId: string, artifactIds: string[]) {
    const ids = new Set(artifactIds);
    return structuredClone(this.artifactVersions.filter((item) => item.tenantId === tenantId && ids.has(item.artifactId)).sort((left, right) => left.version - right.version));
  }

  async appendArtifactVersion(artifact: WorkArtifact, version: WorkArtifactVersion, expectedVersion: number) {
    const key = `${artifact.tenantId}:${artifact.id}`;
    const current = this.artifacts.get(key);
    if (!current || current.currentVersion !== expectedVersion || this.artifactVersions.some((item) => item.tenantId === artifact.tenantId && item.artifactId === artifact.id && item.version === version.version)) return false;
    this.artifacts.set(key, structuredClone({ ...current, currentVersion: version.version }));
    this.artifactVersions.push(structuredClone(version));
    return true;
  }

  async initiateHandoff(handoff: WorkTaskHandoff, event: Omit<WorkTaskEvent, "sequence">) {
    const existing = handoff.sourceRunId ? this.handoffs.find((item) => item.tenantId === handoff.tenantId && item.sourceRunId === handoff.sourceRunId) : undefined;
    if (existing) return { handoff: structuredClone(existing), created: false };
    this.handoffs.push(structuredClone(handoff));
    this.events.push({ ...structuredClone(event), sequence: ++this.sequence });
    return { handoff: structuredClone(handoff), created: true };
  }

  async respondToHandoff(input: { current: WorkTaskHandoff; next: WorkTaskHandoff; currentPackage: WorkPackage; nextPackage?: WorkPackage; expectedVersion: number; event: Omit<WorkTaskEvent, "sequence"> }) {
    const handoffIndex = this.handoffs.findIndex((item) => item.tenantId === input.current.tenantId && item.id === input.current.id && item.status === "pending");
    const packageIndex = this.packages.findIndex((item) => item.tenantId === input.currentPackage.tenantId && item.id === input.currentPackage.id && item.version === input.expectedVersion && item.assigneeId === input.current.fromAssigneeId);
    if (handoffIndex < 0 || packageIndex < 0) return false;
    this.handoffs[handoffIndex] = structuredClone(input.next);
    if (input.nextPackage) this.packages[packageIndex] = structuredClone(input.nextPackage);
    this.events.push({ ...structuredClone(input.event), sequence: ++this.sequence });
    return true;
  }

  private async updatePackage(current: WorkPackage, next: WorkPackage, expectedVersion: number, event: Omit<WorkTaskEvent, "sequence">) {
    const index = this.packages.findIndex((item) => item.tenantId === current.tenantId && item.id === current.id);
    if (index < 0 || this.packages[index].version !== expectedVersion) return false;
    this.packages[index] = structuredClone(next);
    this.events.push({ ...structuredClone(event), sequence: ++this.sequence });
    return true;
  }

  async listPoolMessages(tenantId: string) {
    return structuredClone(this.poolMessages.filter((item) => item.tenantId === tenantId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  async listPoolFeedback(tenantId: string, messageIds: string[]) {
    const ids = new Set(messageIds);
    return structuredClone(this.poolFeedback.filter((item) => item.tenantId === tenantId && ids.has(item.messageId)).sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  async getPoolMessage(tenantId: string, id: string) {
    return structuredClone(this.poolMessages.find((item) => item.tenantId === tenantId && item.id === id) ?? null);
  }

  async publishPoolMessage(message: WorkPoolMessage, event: Omit<WorkMessageEvent, "sequence">) {
    const existing = message.sourceRunId ? this.poolMessages.find((item) => item.tenantId === message.tenantId && item.sourceRunId === message.sourceRunId) : undefined;
    if (existing) return { message: structuredClone(existing), created: false };
    this.poolMessages.push(structuredClone(message));
    this.messageEvents.push({ ...structuredClone(event), sequence: ++this.messageSequence });
    return { message: structuredClone(message), created: true };
  }

  async appendPoolFeedback(feedback: WorkPoolFeedback, event: Omit<WorkMessageEvent, "sequence">) {
    this.poolFeedback.push(structuredClone(feedback));
    this.messageEvents.push({ ...structuredClone(event), sequence: ++this.messageSequence });
  }

  async listMessageEvents(tenantId: string, after: number, limit: number) {
    return structuredClone(this.messageEvents.filter((item) => item.tenantId === tenantId && item.sequence > after).slice(0, limit));
  }
}

const runtime = globalThis as typeof globalThis & { __nexusTaskCommandRepository?: InMemoryTaskCommandRepository; __nexusTaskCommandFixtureVersion?: number };

export function getDevelopmentTaskCommandRepository() {
  if (runtime.__nexusTaskCommandFixtureVersion !== 4) {
    runtime.__nexusTaskCommandRepository = new InMemoryTaskCommandRepository();
    runtime.__nexusTaskCommandFixtureVersion = 4;
  }
  return runtime.__nexusTaskCommandRepository!;
}
