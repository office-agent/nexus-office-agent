import type { WorkArtifact, WorkArtifactVersion, WorkConversation, WorkConversationMessage, WorkMessageEvent, WorkMission, WorkOrgUnit, WorkPackage, WorkPerson, WorkPoolFeedback, WorkPoolMessage, WorkTaskEvent, WorkTaskHandoff } from "@/src/modules/task-command/domain/task-command";

export interface TaskCommandRepository {
  getOrCreatePrimaryConversation(tenantId: string, ownerId: string): Promise<WorkConversation>;
  appendMessage(message: WorkConversationMessage): Promise<void>;
  listMessages(tenantId: string, conversationId: string, limit: number): Promise<WorkConversationMessage[]>;
  listPeople(tenantId: string): Promise<WorkPerson[]>;
  listOrgUnits(tenantId: string): Promise<WorkOrgUnit[]>;
  listMissions(tenantId: string): Promise<WorkMission[]>;
  listPackages(tenantId: string): Promise<WorkPackage[]>;
  getPackage(tenantId: string, id: string): Promise<WorkPackage | null>;
  publishMission(mission: WorkMission, packages: WorkPackage[], events: Omit<WorkTaskEvent, "sequence">[]): Promise<{ mission: WorkMission; packages: WorkPackage[]; created: boolean }>;
  claimPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number }): Promise<boolean>;
  transitionPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number }): Promise<boolean>;
  listEvents(tenantId: string, actorId: string, after: number, limit: number): Promise<WorkTaskEvent[]>;
  listHandoffs(tenantId: string, packageIds: string[]): Promise<WorkTaskHandoff[]>;
  getHandoff(tenantId: string, id: string): Promise<WorkTaskHandoff | null>;
  createArtifact(artifact: WorkArtifact, initialVersion: WorkArtifactVersion): Promise<WorkArtifact>;
  getArtifact(tenantId: string, id: string): Promise<WorkArtifact | null>;
  getArtifactVersions(tenantId: string, artifactIds: string[]): Promise<WorkArtifactVersion[]>;
  appendArtifactVersion(artifact: WorkArtifact, version: WorkArtifactVersion, expectedVersion: number): Promise<boolean>;
  initiateHandoff(handoff: WorkTaskHandoff, event: Omit<WorkTaskEvent, "sequence">): Promise<{ handoff: WorkTaskHandoff; created: boolean }>;
  respondToHandoff(input: { current: WorkTaskHandoff; next: WorkTaskHandoff; currentPackage: WorkPackage; nextPackage?: WorkPackage; expectedVersion: number; event: Omit<WorkTaskEvent, "sequence"> }): Promise<boolean>;
  listPoolMessages(tenantId: string): Promise<WorkPoolMessage[]>;
  listPoolFeedback(tenantId: string, messageIds: string[]): Promise<WorkPoolFeedback[]>;
  getPoolMessage(tenantId: string, id: string): Promise<WorkPoolMessage | null>;
  publishPoolMessage(message: WorkPoolMessage, event: Omit<WorkMessageEvent, "sequence">): Promise<{ message: WorkPoolMessage; created: boolean }>;
  appendPoolFeedback(feedback: WorkPoolFeedback, event: Omit<WorkMessageEvent, "sequence">): Promise<void>;
  listMessageEvents(tenantId: string, after: number, limit: number): Promise<WorkMessageEvent[]>;
}
