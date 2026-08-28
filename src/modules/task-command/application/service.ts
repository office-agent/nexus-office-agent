import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { TaskCommandRepository } from "@/src/modules/task-command/application/contracts";
import type { AppendPoolFeedbackInput, AppendTaskArtifactVersionInput, CreateTaskTemplateInput, InitiateTaskHandoffInput, PublishMissionInput, PublishPoolMessageInput, RegisterTaskArtifactInput, RespondToTaskHandoffInput, TransitionPackageInput, UpdateTaskTemplateInput } from "@/src/modules/task-command/application/schemas";
import { claimWorkPackage, createConversationMessage, createMissionBundle, createPoolFeedback, createPoolMessage, createTaskHandoff, createTaskTemplateBundle, handoffWorkPackage, respondToTaskHandoff, transitionWorkPackage, type WorkArtifact, type WorkArtifactVersion, type WorkConversationMessage, type WorkMessageEvent, type WorkMessagePool, type WorkPackage, type WorkTaskEvent, type WorkTaskHandoffArtifactSnapshot, type WorkTemplateField } from "@/src/modules/task-command/domain/task-command";

function hasPermission(context: RequestContext, permission: string): boolean {
  const [resource, action] = permission.split(":");
  return context.permissions.some((value) => value === "*" || value === permission || value === `${resource}:*` || value === `*:${action}`);
}

function requirePermission(context: RequestContext, permission: string) {
  if (!hasPermission(context, permission)) throw new Error(`POLICY_DENIED:${permission}`);
}

function event(input: Omit<WorkTaskEvent, "sequence" | "id" | "occurredAt">): Omit<WorkTaskEvent, "sequence"> {
  return { ...input, id: randomUUID(), occurredAt: new Date().toISOString() };
}

function messageEvent(input: Omit<WorkMessageEvent, "sequence" | "id" | "occurredAt">): Omit<WorkMessageEvent, "sequence"> {
  return { ...input, id: randomUUID(), occurredAt: new Date().toISOString() };
}

function canAccessOrgScope(context: RequestContext, orgUnitId: string): boolean {
  return context.dataScopes.some((scope) =>
    scope.type === "tenant" ||
    (scope.type === "org_subtree" && scope.orgUnitIds.includes(orgUnitId)) ||
    (scope.type === "explicit" && scope.resourceIds.includes(orgUnitId)),
  );
}

type TemplateFieldValues = {
  objective: string;
  description: string;
  acceptanceCriteria: string;
  requiredSkills: string[];
  assignmentMode: "direct" | "open_claim";
  assigneeId?: string;
  targetOrgUnitId?: string;
  priority: "critical" | "high" | "medium" | "low";
  dueAt: string;
  capacityPoints: number;
};

function updateTemplateMissingFields(current: WorkTemplateField[], input: UpdateTaskTemplateInput, values: TemplateFieldValues): WorkTemplateField[] {
  const missing = new Set<WorkTemplateField>(current);
  const has = (key: keyof UpdateTaskTemplateInput) => Object.prototype.hasOwnProperty.call(input, key);
  const setField = (field: WorkTemplateField, complete: boolean) => { if (complete) missing.delete(field); else missing.add(field); };
  if (has("objective")) setField("工作目标", Boolean(values.objective && !values.objective.startsWith("待补充")));
  if (has("description")) setField("任务说明", Boolean(values.description && !values.description.startsWith("待补充")));
  if (has("acceptanceCriteria")) setField("验收标准", Boolean(values.acceptanceCriteria && !values.acceptanceCriteria.startsWith("待补充")));
  if (has("requiredSkills")) setField("所需技能", values.requiredSkills.length > 0);
  if (has("priority")) setField("优先级", Boolean(values.priority));
  if (has("dueAt")) setField("截止时间", Boolean(values.dueAt));
  if (has("capacityPoints")) setField("容量点", Boolean(values.capacityPoints));
  if (has("assignmentMode") || has("assigneeId") || has("targetOrgUnitId")) setField("负责人或承接范围", values.assignmentMode === "direct" ? Boolean(values.assigneeId) : Boolean(values.targetOrgUnitId));
  return [...missing];
}

export class TaskCommandService {
  constructor(private readonly repository: TaskCommandRepository) {}

  /** Resolve the user's primary conversation without loading the full workspace. */
  async primaryConversation(context: RequestContext) {
    requirePermission(context, "work_task:read");
    return this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId);
  }

  async workspace(context: RequestContext) {
    requirePermission(context, "work_task:read");
    const conversation = await this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId);
    const [messages, people, orgUnits, missions, packages] = await Promise.all([
      this.repository.listMessages(context.tenantId, conversation.id, 100),
      this.repository.listPeople(context.tenantId),
      this.repository.listOrgUnits(context.tenantId),
      this.repository.listMissions(context.tenantId),
      this.repository.listPackages(context.tenantId),
    ]);
    const handoffs = await this.repository.listHandoffs(context.tenantId, packages.map(({ id }) => id));
    const actorOrgUnitIds = new Set(people.filter(({ id }) => id === context.actorId).flatMap(({ orgUnitId }) => orgUnitId ? [orgUnitId] : []));
    const canSeeClaim = (item: WorkPackage) => item.assignmentMode === "open_claim" && (!item.targetOrgUnitId || canAccessOrgScope(context, item.targetOrgUnitId) || actorOrgUnitIds.has(item.targetOrgUnitId));
    const handoffParticipantPackageIds = new Set(handoffs.filter((item) => item.fromAssigneeId === context.actorId || item.toAssigneeId === context.actorId).map(({ packageId }) => packageId));
    const visible = packages.filter((item) => item.publishedBy === context.actorId || item.assigneeId === context.actorId || canSeeClaim(item) || handoffParticipantPackageIds.has(item.id));
    const visiblePackageIds = new Set(visible.map(({ id }) => id));
    const visibleHandoffs = handoffs.filter((item) => visiblePackageIds.has(item.packageId));
    const messagePools = hasPermission(context, "message_pool:read")
      ? await this.messagePools(context, people, orgUnits)
      : [];
    return {
      conversation,
      messages,
      people,
      orgUnits,
      missions: missions.filter((mission) => visible.some((item) => item.missionId === mission.id)),
      myTasks: visible.filter((item) => item.assigneeId === context.actorId && !item.isTemplate && !["completed", "cancelled"].includes(item.status)),
      availableTasks: visible.filter((item) => !item.isTemplate && item.assignmentMode === "open_claim" && item.status === "published" && !item.assigneeId),
      publishedByMe: visible.filter((item) => item.publishedBy === context.actorId),
      templates: visible.filter((item) => item.publishedBy === context.actorId && item.isTemplate),
      handoffTasks: visible.filter((item) => handoffParticipantPackageIds.has(item.id)),
      handoffs: visibleHandoffs,
      pendingHandoffs: visibleHandoffs.filter((item) => item.status === "pending" && item.toAssigneeId === context.actorId).flatMap((handoff) => {
        const task = visible.find((item) => item.id === handoff.packageId);
        return task ? [{ handoff, task }] : [];
      }),
      messagePools,
      generatedAt: new Date().toISOString(),
    };
  }

  async appendMessage(context: RequestContext, input: Omit<WorkConversationMessage, "id" | "tenantId" | "createdAt">) {
    if (input.role === "user" && input.conversationId !== (await this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId)).id) {
      throw new Error("WORK_CONVERSATION_NOT_FOUND");
    }
    const message = createConversationMessage({ ...input, tenantId: context.tenantId });
    await this.repository.appendMessage(message);
    return message;
  }

  async publishMission(context: RequestContext, input: PublishMissionInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "work_task:create");
    const conversation = await this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId);
    if (conversation.id !== input.conversationId) throw new Error("WORK_CONVERSATION_NOT_FOUND");
    const people = await this.repository.listPeople(context.tenantId);
    const activeIds = new Set(people.map(({ id }) => id));
    for (const item of input.packages) {
      if (item.assignmentMode === "direct") {
        requirePermission(context, "work_task:assign");
        if (!item.assigneeId || !activeIds.has(item.assigneeId)) throw new Error("WORK_ASSIGNEE_NOT_FOUND");
      }
      if (item.targetOrgUnitId) {
        requirePermission(context, "work_task:assign_department");
        if (!canAccessOrgScope(context, item.targetOrgUnitId)) throw new Error("POLICY_DENIED:work_task:target_scope");
        const exists = (await this.repository.listOrgUnits(context.tenantId)).some(({ id }) => id === item.targetOrgUnitId);
        if (!exists) throw new Error("WORK_TARGET_DEPARTMENT_NOT_FOUND");
      }
    }
    const bundle = createMissionBundle({
      ...input,
      tenantId: context.tenantId,
      publishedBy: context.actorId,
      source: execution?.source ?? "human",
      sourceRunId: execution?.sourceRunId,
    });
    const events: Omit<WorkTaskEvent, "sequence">[] = [
      event({ tenantId: context.tenantId, missionId: bundle.mission.id, eventType: "mission_published", actorId: context.actorId, audience: "tenant", payload: { title: bundle.mission.title, packageCount: bundle.packages.length } }),
      ...bundle.packages.map((item) => event({ tenantId: context.tenantId, missionId: item.missionId, packageId: item.id, eventType: "package_published", actorId: context.actorId, audience: item.assignmentMode === "open_claim" ? "tenant" : "participants", payload: { title: item.title, assigneeId: item.assigneeId, assignmentMode: item.assignmentMode, version: item.version } })),
    ];
    return this.repository.publishMission(bundle.mission, bundle.packages, events);
  }

  async createTaskTemplate(context: RequestContext, input: CreateTaskTemplateInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "work_task:create");
    const conversation = await this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId);
    if (conversation.id !== input.conversationId) throw new Error("WORK_CONVERSATION_NOT_FOUND");
    const bundle = createTaskTemplateBundle({ ...input, tenantId: context.tenantId, publishedBy: context.actorId, source: execution?.source ?? "human", sourceRunId: execution?.sourceRunId });
    const events: Omit<WorkTaskEvent, "sequence">[] = [
      event({ tenantId: context.tenantId, missionId: bundle.mission.id, eventType: "mission_published", actorId: context.actorId, audience: "participants", payload: { title: bundle.mission.title, packageCount: bundle.packages.length, template: true, missingFields: bundle.mission.missingFields } }),
      ...bundle.packages.map((item) => event({ tenantId: context.tenantId, missionId: item.missionId, packageId: item.id, eventType: "package_published", actorId: context.actorId, audience: "participants", payload: { title: item.title, template: true, missingFields: item.missingFields, version: item.version } })),
    ];
    const result = await this.repository.publishMission(bundle.mission, bundle.packages, events);
    const task = result.packages[0];
    return { ...result, missionId: result.mission.id, templateId: task?.id, task };
  }

  async updateTaskTemplate(context: RequestContext, input: UpdateTaskTemplateInput) {
    requirePermission(context, "work_task:update");
    const current = await this.requirePackage(context.tenantId, input.taskId);
    if (!current.isTemplate) throw new Error("WORK_TEMPLATE_ONLY");
    if (current.version !== input.expectedVersion) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    if (current.publishedBy !== context.actorId && !hasPermission(context, "work_task:admin")) throw new Error("POLICY_DENIED:work_task:template_ownership");
    const missions = await this.repository.listMissions(context.tenantId);
    const mission = missions.find((item) => item.id === current.missionId);
    if (!mission) throw new Error("WORK_MISSION_NOT_FOUND");
    const people = await this.repository.listPeople(context.tenantId);
    const orgUnits = await this.repository.listOrgUnits(context.tenantId);
    const assignmentMode = input.assignmentMode ?? current.assignmentMode;
    const assigneeId = input.assigneeId === null ? undefined : input.assigneeId ?? (assignmentMode === "direct" ? current.assigneeId : undefined);
    const targetOrgUnitId = input.targetOrgUnitId === null ? undefined : input.targetOrgUnitId ?? (assignmentMode === "open_claim" ? current.targetOrgUnitId : undefined);
    if (assignmentMode === "direct") {
      requirePermission(context, "work_task:assign");
      if (!assigneeId || !people.some(({ id }) => id === assigneeId)) throw new Error("WORK_ASSIGNEE_NOT_FOUND");
    }
    if (assignmentMode === "open_claim" && assigneeId) throw new Error("WORK_OPEN_CLAIM_ASSIGNEE_FORBIDDEN");
    if (targetOrgUnitId) {
      requirePermission(context, "work_task:assign_department");
      if (!canAccessOrgScope(context, targetOrgUnitId)) throw new Error("POLICY_DENIED:work_task:target_scope");
      if (!orgUnits.some(({ id }) => id === targetOrgUnitId)) throw new Error("WORK_TARGET_DEPARTMENT_NOT_FOUND");
    }
    const title = input.title ?? current.title;
    const objective = input.objective ?? mission.objective;
    const description = input.description ?? current.description;
    const acceptanceCriteria = input.acceptanceCriteria ?? current.acceptanceCriteria;
    const requiredSkills = input.requiredSkills ?? current.requiredSkills;
    const priority = input.priority ?? current.priority;
    const dueAt = input.dueAt ?? current.dueAt;
    const capacityPoints = input.capacityPoints ?? current.capacityPoints;
    const missingFields = updateTemplateMissingFields(current.missingFields, input, { objective, description, acceptanceCriteria, requiredSkills, assignmentMode, assigneeId, targetOrgUnitId, priority, dueAt, capacityPoints });
    const timestamp = new Date().toISOString();
    const nextMission = { ...mission, title, objective, priority, dueAt, version: mission.version + 1, updatedAt: timestamp, missingFields };
    const nextPackage = { ...current, title, description, acceptanceCriteria, requiredSkills: [...new Set(requiredSkills)], assignmentMode, assigneeId, targetOrgUnitId, priority, dueAt, capacityPoints, version: current.version + 1, updatedAt: timestamp, missingFields };
    const changed = await this.repository.updateTaskTemplate({ currentMission: mission, nextMission, currentPackage: current, nextPackage, expectedVersion: input.expectedVersion, event: event({ tenantId: context.tenantId, missionId: current.missionId, packageId: current.id, eventType: "package_status_changed", actorId: context.actorId, audience: "participants", payload: { template: true, missingFields, version: nextPackage.version } }) });
    if (!changed) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    return { mission: nextMission, task: nextPackage, missingFields };
  }

  async claimPackage(context: RequestContext, id: string, expectedVersion: number) {
    requirePermission(context, "work_task:claim");
    const current = await this.requirePackage(context.tenantId, id);
    if (current.targetOrgUnitId) {
      const actorIsMember = (await this.repository.listPeople(context.tenantId)).some((person) => person.id === context.actorId && person.orgUnitId === current.targetOrgUnitId);
      if (!actorIsMember && !canAccessOrgScope(context, current.targetOrgUnitId)) throw new Error("POLICY_DENIED:work_task:claim_scope");
    }
    if (current.version !== expectedVersion) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    const next = claimWorkPackage(current, context.actorId);
    const changed = await this.repository.claimPackage({ current, next, expectedVersion, event: event({ tenantId: context.tenantId, missionId: current.missionId, packageId: current.id, eventType: "package_claimed", actorId: context.actorId, audience: "participants", payload: { assigneeId: context.actorId, version: next.version } }) });
    if (!changed) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    return next;
  }

  async transitionPackage(context: RequestContext, id: string, input: TransitionPackageInput) {
    requirePermission(context, "work_task:update");
    const current = await this.requirePackage(context.tenantId, id);
    if ((await this.repository.listHandoffs(context.tenantId, [current.id])).some(({ status }) => status === "pending")) throw new Error("WORK_HANDOFF_PENDING");
    const canManage = current.assigneeId === context.actorId || current.publishedBy === context.actorId || hasPermission(context, "work_task:admin");
    if (!canManage) throw new Error("POLICY_DENIED:work_task:ownership");
    if (current.version !== input.expectedVersion) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    const next = transitionWorkPackage(current, input);
    const changed = await this.repository.transitionPackage({ current, next, expectedVersion: input.expectedVersion, event: event({ tenantId: context.tenantId, missionId: current.missionId, packageId: current.id, eventType: "package_status_changed", actorId: context.actorId, audience: "participants", payload: { previousStatus: current.status, nextStatus: next.status, version: next.version } }) });
    if (!changed) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    return next;
  }

  async initiateTaskHandoff(context: RequestContext, input: InitiateTaskHandoffInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "work_task:handoff");
    const artifactIds = input.artifactIds ?? [];
    const artifactRefs = input.artifactRefs ?? [];
    const current = await this.requirePackage(context.tenantId, input.taskId);
    if (current.version !== input.expectedVersion) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    if (!current.assigneeId || ["published", "in_review", "completed", "cancelled"].includes(current.status)) throw new Error("WORK_HANDOFF_PACKAGE_NOT_TRANSFERABLE");
    const canInitiate = current.assigneeId === context.actorId || current.publishedBy === context.actorId || hasPermission(context, "work_task:admin");
    if (!canInitiate) throw new Error("POLICY_DENIED:work_task:handoff_ownership");
    if ((await this.repository.listHandoffs(context.tenantId, [current.id])).some(({ status }) => status === "pending")) throw new Error("WORK_HANDOFF_ALREADY_PENDING");
    const people = await this.repository.listPeople(context.tenantId);
    const target = people.find(({ id }) => id === input.toAssigneeId);
    const source = people.find(({ id }) => id === current.assigneeId);
    if (!target) throw new Error("WORK_HANDOFF_TARGET_NOT_FOUND");
    if (target.id === current.assigneeId) throw new Error("WORK_HANDOFF_SAME_ASSIGNEE");
    if (target.orgUnitId !== source?.orgUnitId) {
      requirePermission(context, "work_task:handoff_cross_department");
      if (target.orgUnitId && !canAccessOrgScope(context, target.orgUnitId)) throw new Error("POLICY_DENIED:work_task:handoff_target_scope");
    }
    if (artifactIds.length && artifactRefs.length) throw new Error("WORK_HANDOFF_MIXED_ARTIFACT_REFERENCES_FORBIDDEN");
    const artifactSnapshots = await this.freezeHandoffArtifacts(context, current, artifactIds);
    const handoff = createTaskHandoff({
      tenantId: context.tenantId,
      packageId: current.id,
      missionId: current.missionId,
      fromAssigneeId: current.assigneeId,
      toAssigneeId: target.id,
      initiatedBy: context.actorId,
      note: input.note,
      artifactRefs,
      artifactSnapshots,
      snapshot: {
        packageVersion: current.version,
        status: current.status,
        title: current.title,
        description: current.description,
        acceptanceCriteria: current.acceptanceCriteria,
        requiredSkills: current.requiredSkills,
        evidenceRefs: current.evidenceRefs,
        dueAt: current.dueAt,
      },
      source: execution?.source ?? "human",
      sourceRunId: execution?.sourceRunId,
    });
    return this.repository.initiateHandoff(handoff, event({
      tenantId: context.tenantId,
      missionId: current.missionId,
      packageId: current.id,
      eventType: "package_handoff_initiated",
      actorId: context.actorId,
      audience: "participants",
      payload: { handoffId: handoff.id, fromAssigneeId: handoff.fromAssigneeId, toAssigneeId: handoff.toAssigneeId, packageVersion: handoff.snapshot.packageVersion, artifactSnapshotCount: handoff.artifactSnapshots.length, legacyArtifactRefCount: handoff.artifactRefs.length },
    }));
  }

  async respondToTaskHandoff(context: RequestContext, handoffId: string, input: RespondToTaskHandoffInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "work_task:accept_handoff");
    const current = await this.repository.getHandoff(context.tenantId, handoffId);
    if (!current) throw new Error("WORK_HANDOFF_NOT_FOUND");
    if (current.toAssigneeId !== context.actorId) throw new Error("POLICY_DENIED:work_task:handoff_recipient");
    const task = await this.requirePackage(context.tenantId, current.packageId);
    if (current.status !== "pending") {
      if (execution?.sourceRunId && current.responseRunId === execution.sourceRunId) return { handoff: current, task };
      throw new Error("WORK_HANDOFF_NOT_PENDING");
    }
    if (task.version !== input.expectedVersion || task.version !== current.snapshot.packageVersion || task.assigneeId !== current.fromAssigneeId) throw new Error("WORK_HANDOFF_CHAIN_CHANGED");
    const status = input.decision === "accept" ? "accepted" : "rejected" as const;
    const next = respondToTaskHandoff(current, { status, responseNote: input.responseNote, respondedBy: context.actorId, responseRunId: execution?.sourceRunId });
    const nextPackage = status === "accepted" ? handoffWorkPackage(task, current.toAssigneeId) : undefined;
    const changed = await this.repository.respondToHandoff({
      current,
      next,
      currentPackage: task,
      nextPackage,
      expectedVersion: input.expectedVersion,
      event: event({
        tenantId: context.tenantId,
        missionId: task.missionId,
        packageId: task.id,
        eventType: status === "accepted" ? "package_handoff_accepted" : "package_handoff_rejected",
        actorId: context.actorId,
        audience: "participants",
        payload: { handoffId: current.id, fromAssigneeId: current.fromAssigneeId, toAssigneeId: current.toAssigneeId, decision: input.decision, packageVersion: nextPackage?.version ?? task.version, artifactSnapshotCount: current.artifactSnapshots.length, legacyArtifactRefCount: current.artifactRefs.length },
      }),
    });
    if (!changed) throw new Error("WORK_HANDOFF_CHAIN_CHANGED");
    return { handoff: next, task: nextPackage ?? task };
  }

  async taskHandoffTrail(context: RequestContext, taskId: string) {
    requirePermission(context, "work_task:read");
    const workspace = await this.workspace(context);
    const task = [...workspace.myTasks, ...workspace.availableTasks, ...workspace.publishedByMe, ...workspace.handoffTasks, ...workspace.pendingHandoffs.map(({ task: item }) => item)].find((item) => item.id === taskId);
    if (!task) throw new Error("WORK_HANDOFF_NOT_VISIBLE");
    return { task, handoffs: workspace.handoffs.filter((item) => item.packageId === task.id) };
  }

  async registerTaskArtifact(context: RequestContext, input: RegisterTaskArtifactInput) {
    requirePermission(context, "work_task:update");
    const timestamp = new Date().toISOString();
    const artifact: WorkArtifact = {
      id: randomUUID(), tenantId: context.tenantId, ownerId: context.actorId, title: input.title,
      classification: input.classification, status: "active", currentVersion: 1, createdAt: timestamp,
    };
    const version: WorkArtifactVersion = {
      id: randomUUID(), tenantId: context.tenantId, artifactId: artifact.id, version: 1,
      fileName: input.fileName, mediaType: input.mediaType, contentDigest: input.contentDigest.toLowerCase(),
      storageRef: input.storageRef, createdBy: context.actorId, createdAt: timestamp,
    };
    await this.repository.createArtifact(artifact, version);
    return { artifact, version: this.publicArtifactVersion(version) };
  }

  async appendTaskArtifactVersion(context: RequestContext, artifactId: string, input: AppendTaskArtifactVersionInput) {
    requirePermission(context, "work_task:update");
    const artifact = await this.repository.getArtifact(context.tenantId, artifactId);
    if (!artifact) throw new Error("WORK_ARTIFACT_NOT_FOUND");
    if (artifact.status !== "active") throw new Error("WORK_ARTIFACT_NOT_ACTIVE");
    if (artifact.ownerId !== context.actorId && !hasPermission(context, "work_task:admin")) throw new Error("POLICY_DENIED:work_task:artifact_ownership");
    if (artifact.currentVersion !== input.expectedVersion) throw new Error("WORK_ARTIFACT_VERSION_CONFLICT");
    const timestamp = new Date().toISOString();
    const next: WorkArtifactVersion = {
      id: randomUUID(), tenantId: context.tenantId, artifactId: artifact.id, version: artifact.currentVersion + 1,
      fileName: input.fileName, mediaType: input.mediaType, contentDigest: input.contentDigest.toLowerCase(),
      storageRef: input.storageRef, createdBy: context.actorId, createdAt: timestamp,
    };
    const changed = await this.repository.appendArtifactVersion(artifact, next, input.expectedVersion);
    if (!changed) throw new Error("WORK_ARTIFACT_VERSION_CONFLICT");
    return { artifact: { ...artifact, currentVersion: next.version }, version: this.publicArtifactVersion(next) };
  }

  async taskArtifact(context: RequestContext, artifactId: string) {
    requirePermission(context, "work_task:read");
    const artifact = await this.repository.getArtifact(context.tenantId, artifactId);
    if (!artifact) throw new Error("WORK_ARTIFACT_NOT_FOUND");
    const workspace = await this.workspace(context);
    const visibleByHandoff = workspace.handoffs.some((handoff) => handoff.artifactSnapshots.some((snapshot) => snapshot.artifactId === artifact.id));
    if (artifact.ownerId !== context.actorId && !visibleByHandoff && !hasPermission(context, "work_task:admin")) throw new Error("WORK_ARTIFACT_NOT_VISIBLE");
    const versions = await this.repository.getArtifactVersions(context.tenantId, [artifact.id]);
    return { artifact, versions: versions.map((item) => this.publicArtifactVersion(item)) };
  }

  async events(context: RequestContext, after: number, limit = 100) {
    requirePermission(context, "work_task:read");
    const [items, workspace] = await Promise.all([
      this.repository.listEvents(context.tenantId, context.actorId, after, 200),
      this.workspace(context),
    ]);
    const visiblePackageIds = new Set([...workspace.myTasks, ...workspace.availableTasks, ...workspace.publishedByMe].map(({ id }) => id));
    const visibleMissionIds = new Set(workspace.missions.map(({ id }) => id));
    return items.filter((item) => item.packageId ? visiblePackageIds.has(item.packageId) : visibleMissionIds.has(item.missionId)).slice(0, Math.min(limit, 200));
  }

  async messageEvents(context: RequestContext, after: number, limit = 100) {
    requirePermission(context, "message_pool:read");
    const [people, orgUnits, events] = await Promise.all([
      this.repository.listPeople(context.tenantId),
      this.repository.listOrgUnits(context.tenantId),
      this.repository.listMessageEvents(context.tenantId, after, Math.min(limit, 200)),
    ]);
    const visibleKeys = new Set((await this.messagePoolCatalog(context, people, orgUnits)).map(({ key }) => key));
    return events.filter(({ poolKey }) => visibleKeys.has(poolKey));
  }

  async publishPoolMessage(context: RequestContext, input: PublishPoolMessageInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "message_pool:publish");
    const [people, orgUnits] = await Promise.all([this.repository.listPeople(context.tenantId), this.repository.listOrgUnits(context.tenantId)]);
    const pool = (await this.messagePoolCatalog(context, people, orgUnits)).find(({ key }) => key === input.poolKey);
    if (!pool) throw new Error("MESSAGE_POOL_NOT_VISIBLE");
    const message = createPoolMessage({
      tenantId: context.tenantId,
      poolKey: pool.key,
      poolScope: pool.scope,
      orgUnitId: pool.orgUnitId,
      subject: input.subject,
      content: input.content,
      authorId: context.actorId,
      source: execution?.source ?? "human",
      sourceRunId: execution?.sourceRunId,
    });
    return this.repository.publishPoolMessage(message, messageEvent({
      tenantId: context.tenantId,
      poolKey: message.poolKey,
      poolScope: message.poolScope,
      orgUnitId: message.orgUnitId,
      messageId: message.id,
      eventType: "message_published",
      actorId: context.actorId,
    }));
  }

  async appendPoolFeedback(context: RequestContext, input: AppendPoolFeedbackInput) {
    requirePermission(context, "message_pool:publish");
    const message = await this.repository.getPoolMessage(context.tenantId, input.messageId);
    if (!message) throw new Error("MESSAGE_POOL_MESSAGE_NOT_FOUND");
    const [people, orgUnits] = await Promise.all([this.repository.listPeople(context.tenantId), this.repository.listOrgUnits(context.tenantId)]);
    const visibleKeys = new Set((await this.messagePoolCatalog(context, people, orgUnits)).map(({ key }) => key));
    if (!visibleKeys.has(message.poolKey)) throw new Error("MESSAGE_POOL_NOT_VISIBLE");
    const feedback = createPoolFeedback({ tenantId: context.tenantId, messageId: message.id, content: input.content, authorId: context.actorId });
    await this.repository.appendPoolFeedback(feedback, messageEvent({
      tenantId: context.tenantId,
      poolKey: message.poolKey,
      poolScope: message.poolScope,
      orgUnitId: message.orgUnitId,
      messageId: message.id,
      eventType: "feedback_published",
      actorId: context.actorId,
    }));
    return feedback;
  }

  async agentContext(context: RequestContext) {
    const workspace = await this.workspace(context);
    const people = workspace.people.map((person) => `${person.displayName}[${person.id}]：在手 ${person.activeTaskCount} 项${person.positionName ? `，${person.positionName}` : ""}`).join("；") || "没有可分派成员";
    const myTasks = workspace.myTasks.slice(0, 8).map((item) => `${item.title}[${item.id}]，${item.status}，v${item.version}`).join("；") || "无";
    const templates = workspace.templates.slice(0, 8).map((item) => `${item.title}[${item.id}]，模板，待补充：${item.missingFields.join("、") || "无"}，v${item.version}`).join("；") || "无";
    const available = workspace.availableTasks.slice(0, 8).map((item) => `${item.title}[${item.id}]，v${item.version}`).join("；") || "无";
    const departments = workspace.orgUnits.map((unit) => `${unit.name}[${unit.id}]`).join("；") || "无";
    const pools = workspace.messagePools.map((pool) => `${pool.name}[${pool.key}]：${pool.messages.slice(0, 2).map((item) => `${item.subject}[${item.id}]`).join("、") || "暂无消息"}`).join("；") || "当前无可见消息池";
    const pendingHandoffs = workspace.pendingHandoffs.slice(0, 6).map(({ handoff, task }) => `${task.title}[${task.id}] 的交接[${handoff.id}]：${handoff.fromAssigneeId} → 当前用户，任务版本 v${handoff.snapshot.packageVersion}，冻结交付物 ${handoff.artifactSnapshots.length} 项${handoff.artifactRefs.length ? `，旧式引用 ${handoff.artifactRefs.length} 项` : ""}`).join("；") || "无";
    const handoffTrail = workspace.handoffs.slice(-8).map((item) => `${item.snapshot.title}[${item.packageId}]：${item.fromAssigneeId} → ${item.toAssigneeId}，${item.status}，冻结交付物 ${item.artifactSnapshots.length} 项${item.artifactRefs.length ? `，旧式引用 ${item.artifactRefs.length} 项` : ""}`).join("；") || "无";
    return {
      conversationId: workspace.conversation.id,
      summary: `<untrusted_task_context>\n主对话ID：${workspace.conversation.id}\n可分派成员：${people}\n可定向部门：${departments}\n我的进行中任务：${myTasks}\n我的任务模板：${templates}\n可主动承接任务：${available}\n待我签收的交接：${pendingHandoffs}\n可见交接链：${handoffTrail}\n</untrusted_task_context>\n<untrusted_message_pool_context>\n可见消息池：${pools}\n</untrusted_message_pool_context>`,
      packages: [...workspace.myTasks, ...workspace.availableTasks, ...workspace.templates].slice(0, 12),
      handoffs: workspace.handoffs.slice(-12),
      poolMessages: workspace.messagePools.flatMap((pool) => pool.messages).slice(0, 12),
    };
  }

  private async messagePools(context: RequestContext, people: Awaited<ReturnType<TaskCommandRepository["listPeople"]>>, orgUnits: Awaited<ReturnType<TaskCommandRepository["listOrgUnits"]>>) {
    const pools = await this.messagePoolCatalog(context, people, orgUnits);
    const poolKeys = new Set(pools.map(({ key }) => key));
    const messages = (await this.repository.listPoolMessages(context.tenantId)).filter((item) => poolKeys.has(item.poolKey));
    const feedback = await this.repository.listPoolFeedback(context.tenantId, messages.map(({ id }) => id));
    return pools.map((pool) => ({
      ...pool,
      messages: messages.filter((item) => item.poolKey === pool.key).slice(0, 20).map((message) => ({
        ...message,
        feedback: feedback.filter((item) => item.messageId === message.id),
      })),
    }));
  }

  private async messagePoolCatalog(context: RequestContext, people: Awaited<ReturnType<TaskCommandRepository["listPeople"]>>, orgUnits: Awaited<ReturnType<TaskCommandRepository["listOrgUnits"]>>): Promise<WorkMessagePool[]> {
    const canModerate = hasPermission(context, "message_pool:moderate");
    const actorOrgUnitIds = new Set(people.filter(({ id }) => id === context.actorId).flatMap(({ orgUnitId }) => orgUnitId ? [orgUnitId] : []));
    return [
      { key: "company", name: "全公司", scope: "company" as const },
      ...orgUnits.filter((unit) => canModerate || actorOrgUnitIds.has(unit.id) || canAccessOrgScope(context, unit.id)).map((unit) => ({ key: unit.id, name: unit.name, scope: "department" as const, orgUnitId: unit.id })),
    ];
  }

  private async requirePackage(tenantId: string, id: string): Promise<WorkPackage> {
    const item = await this.repository.getPackage(tenantId, id);
    if (!item) throw new Error("WORK_PACKAGE_NOT_FOUND");
    return item;
  }

  private async freezeHandoffArtifacts(context: RequestContext, task: WorkPackage, artifactIds: string[]): Promise<WorkTaskHandoffArtifactSnapshot[]> {
    if (!artifactIds.length) return [];
    const uniqueIds = [...new Set(artifactIds)];
    const [artifacts, versions] = await Promise.all([
      Promise.all(uniqueIds.map((id) => this.repository.getArtifact(context.tenantId, id))),
      this.repository.getArtifactVersions(context.tenantId, uniqueIds),
    ]);
    if (artifacts.some((item) => !item)) throw new Error("WORK_HANDOFF_ARTIFACT_NOT_FOUND");
    const resolved = artifacts as WorkArtifact[];
    const inheritedArtifactIds = new Set((await this.repository.listHandoffs(context.tenantId, [task.id]))
      .filter((handoff) => handoff.status === "accepted" && handoff.toAssigneeId === task.assigneeId)
      .flatMap((handoff) => handoff.artifactSnapshots.map((snapshot) => snapshot.artifactId)));
    for (const artifact of resolved) {
      if (artifact.status !== "active") throw new Error("WORK_HANDOFF_ARTIFACT_NOT_ACTIVE");
      if (artifact.ownerId !== task.assigneeId && artifact.ownerId !== context.actorId && !inheritedArtifactIds.has(artifact.id) && !hasPermission(context, "work_task:admin")) throw new Error("POLICY_DENIED:work_task:artifact_ownership");
      if (["confidential", "restricted"].includes(artifact.classification) && !hasPermission(context, "work_task:admin")) throw new Error("POLICY_DENIED:work_task:artifact_classification");
    }
    return resolved.map((artifact) => {
      const version = versions.find((item) => item.artifactId === artifact.id && item.version === artifact.currentVersion);
      if (!version) throw new Error("WORK_HANDOFF_ARTIFACT_VERSION_MISSING");
      return {
        artifactId: artifact.id, artifactVersionId: version.id, version: version.version, title: artifact.title,
        fileName: version.fileName, mediaType: version.mediaType, contentDigest: version.contentDigest,
        classification: artifact.classification,
      };
    });
  }

  private publicArtifactVersion(value: WorkArtifactVersion) {
    const safe = { ...value };
    delete safe.storageRef;
    return safe;
  }
}
