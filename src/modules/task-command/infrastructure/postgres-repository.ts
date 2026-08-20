import type { TaskCommandRepository } from "@/src/modules/task-command/application/contracts";
import type { WorkArtifact, WorkArtifactVersion, WorkConversation, WorkConversationMessage, WorkMessageEvent, WorkMission, WorkOrgUnit, WorkPackage, WorkPerson, WorkPoolFeedback, WorkPoolMessage, WorkTaskEvent, WorkTaskHandoff } from "@/src/modules/task-command/domain/task-command";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";

type Row = Record<string, unknown>;
const text = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalText = (value: unknown) => value === null || value === undefined ? undefined : text(value);
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

const mapConversation = (row: Row): WorkConversation => ({
  id: text(row.id), tenantId: text(row.tenant_id), ownerId: text(row.owner_id), title: text(row.title), status: row.status as WorkConversation["status"],
  version: Number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});
const mapMessage = (row: Row): WorkConversationMessage => ({
  id: text(row.id), tenantId: text(row.tenant_id), conversationId: text(row.conversation_id), role: row.role as WorkConversationMessage["role"], content: text(row.content),
  runId: optionalText(row.run_id), route: json<WorkConversationMessage["route"]>(row.route), citations: json<WorkConversationMessage["citations"]>(row.citations), createdAt: text(row.created_at),
});
const mapMission = (row: Row): WorkMission => ({
  id: text(row.id), tenantId: text(row.tenant_id), conversationId: text(row.conversation_id), projectId: optionalText(row.project_id), title: text(row.title), objective: text(row.objective),
  priority: row.priority as WorkMission["priority"], dueAt: text(row.due_at), status: row.status as WorkMission["status"], publishedBy: text(row.published_by),
  source: row.source as WorkMission["source"], sourceRunId: optionalText(row.source_run_id), version: Number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});
const mapPackage = (row: Row): WorkPackage => ({
  id: text(row.id), tenantId: text(row.tenant_id), missionId: text(row.mission_id), ordinal: Number(row.ordinal), title: text(row.title), description: text(row.description),
  acceptanceCriteria: text(row.acceptance_criteria), requiredSkills: json<string[]>(row.required_skills), assignmentMode: row.assignment_mode as WorkPackage["assignmentMode"],
  assigneeId: optionalText(row.assignee_id), targetOrgUnitId: optionalText(row.target_org_unit_id), publishedBy: text(row.published_by), priority: row.priority as WorkPackage["priority"], dueAt: text(row.due_at), capacityPoints: Number(row.capacity_points),
  status: row.status as WorkPackage["status"], evidenceRefs: json<string[]>(row.evidence_refs), blockedReason: optionalText(row.blocked_reason), claimedAt: optionalText(row.claimed_at),
  completedAt: optionalText(row.completed_at), version: Number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});
const mapEvent = (row: Row): WorkTaskEvent => ({
  sequence: Number(row.sequence), id: text(row.id), tenantId: text(row.tenant_id), missionId: text(row.mission_id), packageId: optionalText(row.package_id),
  eventType: row.event_type as WorkTaskEvent["eventType"], actorId: text(row.actor_id), audience: row.audience as WorkTaskEvent["audience"], payload: json<Record<string, unknown>>(row.payload), occurredAt: text(row.occurred_at),
});
const mapHandoff = (row: Row): WorkTaskHandoff => ({
  id: text(row.id), tenantId: text(row.tenant_id), packageId: text(row.package_id), missionId: text(row.mission_id), fromAssigneeId: text(row.from_assignee_id), toAssigneeId: text(row.to_assignee_id),
  initiatedBy: text(row.initiated_by), note: text(row.note), artifactRefs: json<string[]>(row.artifact_refs), artifactSnapshots: json<WorkTaskHandoff["artifactSnapshots"]>(row.artifact_snapshots), snapshot: json<WorkTaskHandoff["snapshot"]>(row.package_snapshot),
  source: row.source as WorkTaskHandoff["source"], sourceRunId: optionalText(row.source_run_id), status: row.status as WorkTaskHandoff["status"], responseNote: optionalText(row.response_note),
  respondedBy: optionalText(row.responded_by), responseRunId: optionalText(row.response_run_id), createdAt: text(row.created_at), respondedAt: optionalText(row.responded_at),
});
const mapArtifact = (row: Row): WorkArtifact => ({
  id: text(row.id), tenantId: text(row.tenant_id), ownerId: text(row.owner_id), title: text(row.title),
  classification: row.classification as WorkArtifact["classification"], status: row.status as WorkArtifact["status"], currentVersion: Number(row.current_version), createdAt: text(row.created_at),
});
const mapArtifactVersion = (row: Row): WorkArtifactVersion => ({
  id: text(row.id), tenantId: text(row.tenant_id), artifactId: text(row.artifact_id), version: Number(row.version), fileName: text(row.file_name), mediaType: text(row.media_type),
  contentDigest: text(row.content_digest), storageRef: optionalText(row.storage_ref), createdBy: text(row.created_by), createdAt: text(row.created_at),
});
const poolKey = (scope: string, orgUnitId: unknown): WorkPoolMessage["poolKey"] => scope === "company" ? "company" : text(orgUnitId);
const mapPoolMessage = (row: Row): WorkPoolMessage => ({
  id: text(row.id), tenantId: text(row.tenant_id), poolKey: poolKey(text(row.pool_scope), row.org_unit_id), poolScope: row.pool_scope as WorkPoolMessage["poolScope"], orgUnitId: optionalText(row.org_unit_id),
  subject: text(row.subject), content: text(row.content), authorId: text(row.author_id), source: row.source as WorkPoolMessage["source"], sourceRunId: optionalText(row.source_run_id), createdAt: text(row.created_at),
});
const mapPoolFeedback = (row: Row): WorkPoolFeedback => ({
  id: text(row.id), tenantId: text(row.tenant_id), messageId: text(row.message_id), content: text(row.content), authorId: text(row.author_id), createdAt: text(row.created_at),
});
const mapMessageEvent = (row: Row): WorkMessageEvent => ({
  sequence: Number(row.sequence), id: text(row.id), tenantId: text(row.tenant_id), poolKey: poolKey(text(row.pool_scope), row.org_unit_id), poolScope: row.pool_scope as WorkMessageEvent["poolScope"], orgUnitId: optionalText(row.org_unit_id),
  messageId: text(row.message_id), eventType: row.event_type as WorkMessageEvent["eventType"], actorId: text(row.actor_id), occurredAt: text(row.occurred_at),
});

export class PostgresTaskCommandRepository implements TaskCommandRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getOrCreatePrimaryConversation(tenantId: string, ownerId: string) {
    return this.database.withTenant(tenantId, async (db) => {
      const existing = await db.query("SELECT * FROM work_conversations WHERE tenant_id=$1 AND owner_id=$2 AND status='active' ORDER BY created_at LIMIT 1", [tenantId,ownerId]);
      if (existing[0]) return mapConversation(existing[0]);
      const id = crypto.randomUUID();
      await db.query(`INSERT INTO work_conversations(id,tenant_id,owner_id,title,status) VALUES($1,$2,$3,'主工作对话','active') ON CONFLICT DO NOTHING`, [id,tenantId,ownerId]);
      const rows = await db.query("SELECT * FROM work_conversations WHERE tenant_id=$1 AND owner_id=$2 AND status='active' ORDER BY created_at LIMIT 1", [tenantId,ownerId]);
      if (!rows[0]) throw new Error("WORK_CONVERSATION_CREATE_FAILED");
      return mapConversation(rows[0]);
    });
  }

  async appendMessage(value: WorkConversationMessage) {
    await this.database.withTenant(value.tenantId, (db) => db.query(
      `INSERT INTO work_conversation_messages(id,tenant_id,conversation_id,role,content,run_id,route,citations,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [value.id,value.tenantId,value.conversationId,value.role,value.content,value.runId ?? null,value.route,value.citations,value.createdAt],
    ).then(() => undefined));
  }

  async listMessages(tenantId: string, conversationId: string, limit: number) {
    return this.database.withTenant(tenantId, async (db) => (await db.query(
      `SELECT * FROM (SELECT * FROM work_conversation_messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3) recent ORDER BY created_at,id`,
      [tenantId,conversationId,limit],
    )).map(mapMessage));
  }

  async listPeople(tenantId: string): Promise<WorkPerson[]> {
    return this.database.withTenant(tenantId, async (db) => (await db.query(
      `SELECT u.id::text,u.display_name,m.org_unit_id::text,ou.name AS org_name,p.name AS position_name,
         count(wp.id) FILTER (WHERE wp.status NOT IN ('completed','cancelled'))::int AS active_task_count
       FROM users u
       LEFT JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id AND m.starts_at<=now() AND (m.ends_at IS NULL OR m.ends_at>now())
       LEFT JOIN org_units ou ON ou.tenant_id=m.tenant_id AND ou.id=m.org_unit_id
       LEFT JOIN positions p ON p.tenant_id=m.tenant_id AND p.id=m.position_id
       LEFT JOIN work_packages wp ON wp.tenant_id=u.tenant_id AND wp.assignee_id=u.id
       WHERE u.tenant_id=$1 AND u.status='active' AND u.archived_at IS NULL
       GROUP BY u.id,u.display_name,m.org_unit_id,ou.name,p.name ORDER BY active_task_count,u.display_name`, [tenantId],
    )).map((row) => ({ id: text(row.id), displayName: text(row.display_name), orgUnitId: optionalText(row.org_unit_id), orgName: optionalText(row.org_name), positionName: optionalText(row.position_name), activeTaskCount: Number(row.active_task_count) })));
  }

  async listOrgUnits(tenantId: string): Promise<WorkOrgUnit[]> {
    return this.database.withTenant(tenantId, async (db) => (await db.query("SELECT id::text,name FROM org_units WHERE tenant_id=$1 AND status='active' ORDER BY name,id", [tenantId])).map((row) => ({ id: text(row.id), name: text(row.name) })));
  }

  async listMissions(tenantId: string) { return this.database.withTenant(tenantId, async (db) => (await db.query("SELECT * FROM work_missions WHERE tenant_id=$1 ORDER BY created_at DESC,id", [tenantId])).map(mapMission)); }
  async listPackages(tenantId: string) { return this.database.withTenant(tenantId, async (db) => (await db.query("SELECT * FROM work_packages WHERE tenant_id=$1 ORDER BY updated_at DESC,id", [tenantId])).map(mapPackage)); }
  async getPackage(tenantId: string, id: string) { return this.database.withTenant(tenantId, async (db) => { const rows = await db.query("SELECT * FROM work_packages WHERE tenant_id=$1 AND id=$2", [tenantId,id]); return rows[0] ? mapPackage(rows[0]) : null; }); }

  async publishMission(mission: WorkMission, packages: WorkPackage[], events: Omit<WorkTaskEvent, "sequence">[]) {
    return this.database.withTenant(mission.tenantId, async (db) => {
      const inserted = await db.query(`INSERT INTO work_missions(id,tenant_id,conversation_id,project_id,title,objective,priority,due_at,status,published_by,source,source_run_id,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING RETURNING id`,
        [mission.id,mission.tenantId,mission.conversationId,mission.projectId ?? null,mission.title,mission.objective,mission.priority,mission.dueAt,mission.status,mission.publishedBy,mission.source,mission.sourceRunId ?? null,mission.version,mission.createdAt,mission.updatedAt]);
      if (!inserted.length && mission.sourceRunId) {
        const existingRows = await db.query("SELECT * FROM work_missions WHERE tenant_id=$1 AND source_run_id=$2", [mission.tenantId,mission.sourceRunId]);
        if (existingRows[0]) {
          const existing = mapMission(existingRows[0]);
          const existingPackages = (await db.query("SELECT * FROM work_packages WHERE tenant_id=$1 AND mission_id=$2 ORDER BY ordinal", [mission.tenantId,existing.id])).map(mapPackage);
          return { mission: existing, packages: existingPackages, created: false };
        }
      }
      if (!inserted.length) throw new Error("WORK_MISSION_CONFLICT");
      for (const item of packages) await this.insertPackage(db, item);
      for (const item of events) await this.insertEvent(db, item);
      return { mission, packages, created: true };
    });
  }

  async claimPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number }) {
    return this.updatePackage(input.current.tenantId, input.next, input.expectedVersion, input.event, "assignment_mode='open_claim' AND status='published' AND assignee_id IS NULL");
  }

  async transitionPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number }) {
    return this.updatePackage(input.current.tenantId, input.next, input.expectedVersion, input.event, "true");
  }

  async listEvents(tenantId: string, actorId: string, after: number, limit: number) {
    void actorId;
    return this.database.withTenant(tenantId, async (db) => (await db.query(
      "SELECT * FROM work_task_events WHERE tenant_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3", [tenantId,after,limit],
    )).map(mapEvent));
  }

  async listHandoffs(tenantId: string, packageIds: string[]) {
    if (!packageIds.length) return [];
    return this.database.withTenant(tenantId, async (db) => (await db.query(
      "SELECT * FROM work_task_handoffs WHERE tenant_id=$1 AND package_id = ANY($2::uuid[]) ORDER BY created_at,id", [tenantId,packageIds],
    )).map(mapHandoff));
  }

  async getHandoff(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query("SELECT * FROM work_task_handoffs WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapHandoff(rows[0]) : null;
    });
  }

  async createArtifact(artifact: WorkArtifact, initialVersion: WorkArtifactVersion) {
    return this.database.withTenant(artifact.tenantId, async (db) => {
      await db.query(`INSERT INTO work_artifacts(id,tenant_id,owner_id,title,classification,status,current_version,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [artifact.id,artifact.tenantId,artifact.ownerId,artifact.title,artifact.classification,artifact.status,artifact.currentVersion,artifact.createdAt]);
      await db.query(`INSERT INTO work_artifact_versions(id,tenant_id,artifact_id,version,file_name,media_type,content_digest,storage_ref,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [initialVersion.id,initialVersion.tenantId,initialVersion.artifactId,initialVersion.version,initialVersion.fileName,initialVersion.mediaType,initialVersion.contentDigest,initialVersion.storageRef ?? null,initialVersion.createdBy,initialVersion.createdAt]);
      return artifact;
    });
  }

  async getArtifact(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query("SELECT * FROM work_artifacts WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapArtifact(rows[0]) : null;
    });
  }

  async getArtifactVersions(tenantId: string, artifactIds: string[]) {
    if (!artifactIds.length) return [];
    return this.database.withTenant(tenantId, async (db) => (await db.query(
      "SELECT * FROM work_artifact_versions WHERE tenant_id=$1 AND artifact_id = ANY($2::uuid[]) ORDER BY artifact_id,version", [tenantId,artifactIds],
    )).map(mapArtifactVersion));
  }

  async appendArtifactVersion(artifact: WorkArtifact, version: WorkArtifactVersion, expectedVersion: number) {
    return this.database.withTenant(artifact.tenantId, async (db) => {
      const updated = await db.query(`UPDATE work_artifacts SET current_version=$3 WHERE tenant_id=$1 AND id=$2 AND current_version=$4 AND status='active' RETURNING id`, [artifact.tenantId,artifact.id,version.version,expectedVersion]);
      if (!updated.length) return false;
      await db.query(`INSERT INTO work_artifact_versions(id,tenant_id,artifact_id,version,file_name,media_type,content_digest,storage_ref,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [version.id,version.tenantId,version.artifactId,version.version,version.fileName,version.mediaType,version.contentDigest,version.storageRef ?? null,version.createdBy,version.createdAt]);
      return true;
    });
  }

  async initiateHandoff(handoff: WorkTaskHandoff, event: Omit<WorkTaskEvent, "sequence">) {
    return this.database.withTenant(handoff.tenantId, async (db) => {
      const inserted = await db.query(`INSERT INTO work_task_handoffs(id,tenant_id,package_id,mission_id,from_assignee_id,to_assignee_id,initiated_by,note,artifact_refs,artifact_snapshots,package_snapshot,source,source_run_id,status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING RETURNING id`,
      [handoff.id,handoff.tenantId,handoff.packageId,handoff.missionId,handoff.fromAssigneeId,handoff.toAssigneeId,handoff.initiatedBy,handoff.note,handoff.artifactRefs,handoff.artifactSnapshots,handoff.snapshot,handoff.source,handoff.sourceRunId ?? null,handoff.status,handoff.createdAt]);
      if (!inserted.length && handoff.sourceRunId) {
        const rows = await db.query("SELECT * FROM work_task_handoffs WHERE tenant_id=$1 AND source_run_id=$2", [handoff.tenantId,handoff.sourceRunId]);
        if (rows[0]) return { handoff: mapHandoff(rows[0]), created: false };
      }
      if (!inserted.length) throw new Error("WORK_HANDOFF_CONFLICT");
      await this.insertEvent(db, event);
      return { handoff, created: true };
    });
  }

  async respondToHandoff(input: { current: WorkTaskHandoff; next: WorkTaskHandoff; currentPackage: WorkPackage; nextPackage?: WorkPackage; expectedVersion: number; event: Omit<WorkTaskEvent, "sequence"> }) {
    return this.database.withTenant(input.current.tenantId, async (db) => {
      const handoffRows = await db.query(`UPDATE work_task_handoffs SET status=$3,response_note=$4,responded_by=$5,response_run_id=$6,responded_at=$7
        WHERE tenant_id=$1 AND id=$2 AND status='pending' RETURNING id`,
      [input.current.tenantId,input.current.id,input.next.status,input.next.responseNote ?? null,input.next.respondedBy ?? null,input.next.responseRunId ?? null,input.next.respondedAt ?? null]);
      if (!handoffRows.length) {
        if (input.next.responseRunId) {
          const replay = await db.query("SELECT id FROM work_task_handoffs WHERE tenant_id=$1 AND id=$2 AND response_run_id=$3", [input.current.tenantId,input.current.id,input.next.responseRunId]);
          if (replay.length) return true;
        }
        return false;
      }
      if (input.nextPackage) {
        const packageRows = await db.query(`UPDATE work_packages SET assignee_id=$3,target_org_unit_id=$4,status=$5,evidence_refs=$6,blocked_reason=$7,claimed_at=$8,completed_at=$9,version=$10,updated_at=$11
          WHERE tenant_id=$1 AND id=$2 AND version=$12 AND assignee_id=$13 RETURNING id`,
        [input.current.tenantId,input.nextPackage.id,input.nextPackage.assigneeId ?? null,input.nextPackage.targetOrgUnitId ?? null,input.nextPackage.status,input.nextPackage.evidenceRefs,input.nextPackage.blockedReason ?? null,input.nextPackage.claimedAt ?? null,input.nextPackage.completedAt ?? null,input.nextPackage.version,input.nextPackage.updatedAt,input.expectedVersion,input.current.fromAssigneeId]);
        if (!packageRows.length) throw new Error("WORK_HANDOFF_CHAIN_CHANGED");
      } else {
        const packageRows = await db.query("SELECT id FROM work_packages WHERE tenant_id=$1 AND id=$2 AND version=$3 AND assignee_id=$4", [input.current.tenantId,input.currentPackage.id,input.expectedVersion,input.current.fromAssigneeId]);
        if (!packageRows.length) throw new Error("WORK_HANDOFF_CHAIN_CHANGED");
      }
      await this.insertEvent(db, input.event);
      return true;
    });
  }

  async listPoolMessages(tenantId: string) {
    return this.database.withTenant(tenantId, async (db) => (await db.query("SELECT * FROM work_pool_messages WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC", [tenantId])).map(mapPoolMessage));
  }

  async listPoolFeedback(tenantId: string, messageIds: string[]) {
    if (!messageIds.length) return [];
    return this.database.withTenant(tenantId, async (db) => (await db.query("SELECT * FROM work_pool_feedback WHERE tenant_id=$1 AND message_id = ANY($2::uuid[]) ORDER BY created_at,id", [tenantId,messageIds])).map(mapPoolFeedback));
  }

  async getPoolMessage(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query("SELECT * FROM work_pool_messages WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapPoolMessage(rows[0]) : null;
    });
  }

  async publishPoolMessage(message: WorkPoolMessage, event: Omit<WorkMessageEvent, "sequence">) {
    return this.database.withTenant(message.tenantId, async (db) => {
      const inserted = await db.query(`INSERT INTO work_pool_messages(id,tenant_id,pool_scope,org_unit_id,subject,content,author_id,source,source_run_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
      [message.id,message.tenantId,message.poolScope,message.orgUnitId ?? null,message.subject,message.content,message.authorId,message.source,message.sourceRunId ?? null,message.createdAt]);
      if (!inserted.length && message.sourceRunId) {
        const rows = await db.query("SELECT * FROM work_pool_messages WHERE tenant_id=$1 AND source_run_id=$2", [message.tenantId,message.sourceRunId]);
        if (rows[0]) return { message: mapPoolMessage(rows[0]), created: false };
      }
      if (!inserted.length) throw new Error("MESSAGE_POOL_MESSAGE_CONFLICT");
      await this.insertMessageEvent(db, event);
      return { message, created: true };
    });
  }

  async appendPoolFeedback(feedback: WorkPoolFeedback, event: Omit<WorkMessageEvent, "sequence">) {
    await this.database.withTenant(feedback.tenantId, async (db) => {
      await db.query("INSERT INTO work_pool_feedback(id,tenant_id,message_id,content,author_id,created_at) VALUES($1,$2,$3,$4,$5,$6)", [feedback.id,feedback.tenantId,feedback.messageId,feedback.content,feedback.authorId,feedback.createdAt]);
      await this.insertMessageEvent(db, event);
    });
  }

  async listMessageEvents(tenantId: string, after: number, limit: number) {
    return this.database.withTenant(tenantId, async (db) => (await db.query("SELECT * FROM work_message_events WHERE tenant_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3", [tenantId,after,limit])).map(mapMessageEvent));
  }

  private async updatePackage(tenantId: string, value: WorkPackage, expectedVersion: number, event: Omit<WorkTaskEvent, "sequence">, predicate: string) {
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query(`UPDATE work_packages SET assignee_id=$3,target_org_unit_id=$4,status=$5,evidence_refs=$6,blocked_reason=$7,claimed_at=$8,completed_at=$9,version=$10,updated_at=$11
        WHERE tenant_id=$1 AND id=$2 AND version=$12 AND ${predicate} RETURNING id`,
        [tenantId,value.id,value.assigneeId ?? null,value.targetOrgUnitId ?? null,value.status,value.evidenceRefs,value.blockedReason ?? null,value.claimedAt ?? null,value.completedAt ?? null,value.version,value.updatedAt,expectedVersion]);
      if (!rows.length) return false;
      await this.insertEvent(db, event);
      return true;
    });
  }

  private async insertPackage(db: DatabaseExecutor, value: WorkPackage) {
    await db.query(`INSERT INTO work_packages(id,tenant_id,mission_id,ordinal,title,description,acceptance_criteria,required_skills,assignment_mode,assignee_id,target_org_unit_id,published_by,priority,due_at,capacity_points,status,evidence_refs,blocked_reason,claimed_at,completed_at,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [value.id,value.tenantId,value.missionId,value.ordinal,value.title,value.description,value.acceptanceCriteria,value.requiredSkills,value.assignmentMode,value.assigneeId ?? null,value.targetOrgUnitId ?? null,value.publishedBy,value.priority,value.dueAt,value.capacityPoints,value.status,value.evidenceRefs,value.blockedReason ?? null,value.claimedAt ?? null,value.completedAt ?? null,value.version,value.createdAt,value.updatedAt]);
  }

  private async insertEvent(db: DatabaseExecutor, value: Omit<WorkTaskEvent, "sequence">) {
    await db.query(`INSERT INTO work_task_events(id,tenant_id,mission_id,package_id,event_type,actor_id,audience,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [value.id,value.tenantId,value.missionId,value.packageId ?? null,value.eventType,value.actorId,value.audience,value.payload,value.occurredAt]);
  }

  private async insertMessageEvent(db: DatabaseExecutor, value: Omit<WorkMessageEvent, "sequence">) {
    await db.query(`INSERT INTO work_message_events(id,tenant_id,pool_scope,org_unit_id,message_id,event_type,actor_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [value.id,value.tenantId,value.poolScope,value.orgUnitId ?? null,value.messageId,value.eventType,value.actorId,value.occurredAt]);
  }
}
