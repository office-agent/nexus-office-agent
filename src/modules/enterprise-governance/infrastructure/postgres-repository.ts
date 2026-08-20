import { randomUUID } from "node:crypto";
import type { EnterpriseGovernanceRepository, EnterpriseGovernanceWorkspace, GovernedObjectiveRecord, GovernedProjectRecord } from "@/src/modules/enterprise-governance/application/contracts";
import type {
  AttentionSource,
  CompensationPlan,
  ManagementAttentionItem,
  OrganizationChangeCase,
  ProjectBaseline,
  ProjectChangeRequest,
  ProjectClosureReview,
  WorkHandoff,
} from "@/src/modules/enterprise-governance/domain/governance";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";

type Row = Record<string, unknown>;
const text = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalText = (value: unknown) => value === null || value === undefined ? undefined : text(value);
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

const mapOrganizationChange = (row: Row): OrganizationChangeCase => ({
  id: text(row.id), tenantId: text(row.tenant_id), subjectUserId: text(row.subject_user_id), changeType: row.change_type as OrganizationChangeCase["changeType"],
  effectiveAt: text(row.effective_at), fromOrgUnitId: optionalText(row.from_org_unit_id), toOrgUnitId: optionalText(row.to_org_unit_id), successorUserId: optionalText(row.successor_user_id),
  reason: text(row.reason), status: row.status as OrganizationChangeCase["status"], requestedBy: text(row.requested_by), approvedBy: optionalText(row.approved_by),
  executedAt: optionalText(row.executed_at), version: Number(row.version),
});

const mapHandoff = (row: Row): WorkHandoff => ({
  id: text(row.id), tenantId: text(row.tenant_id), organizationChangeId: text(row.organization_change_id), resourceType: row.resource_type as WorkHandoff["resourceType"],
  resourceId: text(row.resource_id), fromUserId: text(row.from_user_id), toUserId: text(row.to_user_id), status: row.status as WorkHandoff["status"],
  evidenceRef: text(row.evidence_ref), transferredAt: text(row.transferred_at), acceptedAt: optionalText(row.accepted_at), version: Number(row.version),
});

const mapProject = (row: Row): GovernedProjectRecord => ({
  id: text(row.id), tenantId: text(row.tenant_id), code: text(row.code), ownerId: text(row.owner_id), status: row.status as GovernedProjectRecord["status"],
  priority: row.priority as GovernedProjectRecord["priority"], health: row.health as GovernedProjectRecord["health"],
  name: text(row.name), description: text(row.description), businessValue: text(row.business_value), acceptanceCriteria: text(row.acceptance_criteria),
  resourcePlan: json<Record<string, unknown>>(row.resource_plan), startsAt: text(row.starts_at).slice(0, 10), targetEndAt: text(row.target_end_at).slice(0, 10),
  budget: row.budget === null || row.budget === undefined ? undefined : Number(row.budget), currency: optionalText(row.currency), baselineVersion: Number(row.baseline_version), projectVersion: Number(row.version),
});

const mapObjective = (row: Row): GovernedObjectiveRecord => ({
  id: text(row.id), tenantId: text(row.tenant_id), title: text(row.title), description: text(row.description), ownerId: text(row.owner_id),
  status: row.status as GovernedObjectiveRecord["status"], baseline: Number(row.baseline), targetValue: Number(row.target_value), currentValue: Number(row.current_value),
  unit: text(row.unit), startsAt: text(row.starts_at).slice(0, 10), endsAt: text(row.ends_at).slice(0, 10),
  reviewCadence: row.review_cadence as GovernedObjectiveRecord["reviewCadence"], version: Number(row.version),
});

const mapProjectChange = (row: Row): ProjectChangeRequest => ({
  id: text(row.id), tenantId: text(row.tenant_id), projectId: text(row.project_id), changeType: row.change_type as ProjectChangeRequest["changeType"],
  baselineBefore: json<ProjectBaseline>(row.baseline_before), proposedBaseline: json<ProjectChangeRequest["proposedBaseline"]>(row.proposed_baseline),
  reason: text(row.reason), impactAssessment: text(row.impact_assessment), requestedBy: text(row.requested_by), approvedBy: optionalText(row.approved_by),
  status: row.status as ProjectChangeRequest["status"], appliedProjectVersion: row.applied_project_version === null || row.applied_project_version === undefined ? undefined : Number(row.applied_project_version), version: Number(row.version),
});

const mapClosure = (row: Row): ProjectClosureReview => ({
  id: text(row.id), tenantId: text(row.tenant_id), projectId: text(row.project_id), deliveryAcceptanceRef: text(row.delivery_acceptance_ref),
  unresolvedItems: json<ProjectClosureReview["unresolvedItems"]>(row.unresolved_items), retrospectiveRef: text(row.retrospective_ref), ownerId: text(row.owner_id),
  status: row.status as ProjectClosureReview["status"], approvedBy: optionalText(row.approved_by), completedAt: optionalText(row.completed_at), version: Number(row.version),
});

const mapAttention = (row: Row): ManagementAttentionItem => ({
  id: text(row.id), tenantId: text(row.tenant_id), projectId: text(row.project_id), sourceType: row.source_type as ManagementAttentionItem["sourceType"], sourceId: text(row.source_id),
  reasonCode: row.reason_code as ManagementAttentionItem["reasonCode"], severity: row.severity as ManagementAttentionItem["severity"], ownerId: text(row.owner_id), details: json<Record<string, unknown>>(row.details),
  status: row.status as ManagementAttentionItem["status"], detectedAt: text(row.detected_at), resolvedAt: optionalText(row.resolved_at), dedupeKey: text(row.dedupe_key), version: Number(row.version),
});

const mapCompensation = (row: Row): CompensationPlan => ({
  id: text(row.id), tenantId: text(row.tenant_id), sourceOperationType: "project_change", sourceOperationId: text(row.source_operation_id), resourceType: "project", resourceId: text(row.resource_id),
  inversePayload: json<ProjectBaseline>(row.inverse_payload), expectedResourceVersion: Number(row.expected_resource_version), riskLevel: 3, status: row.status as CompensationPlan["status"],
  expiresAt: text(row.expires_at), executedBy: optionalText(row.executed_by), executedAt: optionalText(row.executed_at), version: Number(row.version),
});

export class PostgresEnterpriseGovernanceRepository implements EnterpriseGovernanceRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getWorkspace(tenantId: string): Promise<EnterpriseGovernanceWorkspace> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [objectives, projects, changes, handoffs, projectChanges, closures, attention, compensation] = await Promise.all([
        executor.query("SELECT * FROM objectives WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC,id", [tenantId]),
        executor.query("SELECT * FROM projects WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC,id", [tenantId]),
        executor.query("SELECT * FROM organization_change_cases WHERE tenant_id=$1 ORDER BY created_at DESC,id", [tenantId]),
        executor.query("SELECT * FROM work_handoffs WHERE tenant_id=$1 ORDER BY transferred_at DESC,id", [tenantId]),
        executor.query("SELECT * FROM project_change_requests WHERE tenant_id=$1 ORDER BY created_at DESC,id", [tenantId]),
        executor.query("SELECT * FROM project_closure_reviews WHERE tenant_id=$1 ORDER BY updated_at DESC,id", [tenantId]),
        executor.query("SELECT * FROM management_attention_items WHERE tenant_id=$1 ORDER BY detected_at DESC,id", [tenantId]),
        executor.query("SELECT * FROM compensation_plans WHERE tenant_id=$1 ORDER BY created_at DESC,id", [tenantId]),
      ]);
      return { objectives: objectives.map(mapObjective), projects: projects.map(mapProject), organizationChanges: changes.map(mapOrganizationChange), handoffs: handoffs.map(mapHandoff), projectChanges: projectChanges.map(mapProjectChange), closureReviews: closures.map(mapClosure), attentionItems: attention.map(mapAttention), compensationPlans: compensation.map(mapCompensation), generatedAt: new Date().toISOString() };
    });
  }

  async createInitiative(objective: GovernedObjectiveRecord, project: GovernedProjectRecord) {
    return this.database.withTenant(objective.tenantId, async (executor) => {
      await executor.query(
        `INSERT INTO objectives(id,tenant_id,title,description,owner_id,status,baseline,target_value,current_value,unit,starts_at,ends_at,review_cadence,version)
         VALUES($1,$2,$3,$4,$5,'proposed',$6,$7,$8,$9,$10,$11,$12,1)`,
        [objective.id,objective.tenantId,objective.title,objective.description,objective.ownerId,objective.baseline,objective.targetValue,objective.currentValue,objective.unit,objective.startsAt,objective.endsAt,objective.reviewCadence],
      );
      const inserted = await executor.query(
        `INSERT INTO projects(id,tenant_id,code,name,description,owner_id,status,priority,starts_at,target_end_at,budget,currency,health,version,business_value,acceptance_criteria,resource_plan,baseline_version)
         VALUES($1,$2,$3,$4,$5,$6,'proposed',$7,$8,$9,$10,$11,'unknown',1,$12,$13,$14,1) ON CONFLICT(tenant_id,code) DO NOTHING RETURNING id`,
        [project.id,project.tenantId,project.code,project.name,project.description,project.ownerId,project.priority,project.startsAt,project.targetEndAt,project.budget??null,project.currency??null,project.businessValue,project.acceptanceCriteria,project.resourcePlan],
      );
      if (inserted.length !== 1) throw new Error("PROJECT_CODE_CONFLICT");
      await executor.query("INSERT INTO objective_project_links(tenant_id,objective_id,project_id) VALUES($1,$2,$3)", [objective.tenantId,objective.id,project.id]);
      return true;
    });
  }

  async getOrganizationChange(tenantId: string, id: string) { return this.one(tenantId, "SELECT * FROM organization_change_cases WHERE tenant_id=$1 AND id=$2", id, mapOrganizationChange); }
  async saveOrganizationChange(item: OrganizationChangeCase, expectedVersion?: number) {
    return this.database.withTenant(item.tenantId, async (executor) => {
      if (expectedVersion === undefined) {
        const rows = await executor.query(`INSERT INTO organization_change_cases(id,tenant_id,subject_user_id,change_type,effective_at,from_org_unit_id,to_org_unit_id,successor_user_id,reason,status,requested_by,approved_by,executed_at,version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING id`,
        [item.id,item.tenantId,item.subjectUserId,item.changeType,item.effectiveAt,item.fromOrgUnitId??null,item.toOrgUnitId??null,item.successorUserId??null,item.reason,item.status,item.requestedBy,item.approvedBy??null,item.executedAt??null,item.version]);
        return rows.length === 1;
      }
      const rows = await executor.query("UPDATE organization_change_cases SET status=$3,approved_by=$4,executed_at=$5,version=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$7 RETURNING id", [item.tenantId,item.id,item.status,item.approvedBy??null,item.executedAt??null,item.version,expectedVersion]);
      return rows.length === 1;
    });
  }

  async executeOrganizationChange(item: OrganizationChangeCase): Promise<WorkHandoff[]> {
    return this.database.withTenant(item.tenantId, async (executor) => {
      const locked = await executor.query("UPDATE organization_change_cases SET status='completed',executed_at=$3,version=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='approved' AND version=$5 RETURNING id", [item.tenantId,item.id,item.executedAt!,item.version,item.version-1]);
      if (locked.length !== 1) throw new Error("ORGANIZATION_CHANGE_VERSION_CONFLICT");
      const ownerships = await executor.query<{ resource_type: WorkHandoff["resourceType"]; resource_id: string }>(
        `SELECT 'objective'::text resource_type,id::text resource_id FROM objectives WHERE tenant_id=$1 AND owner_id=$2 AND status NOT IN ('reviewed','cancelled')
         UNION ALL SELECT 'project',id::text FROM projects WHERE tenant_id=$1 AND owner_id=$2 AND status NOT IN ('completed','cancelled')
         UNION ALL SELECT 'task',id::text FROM tasks WHERE tenant_id=$1 AND assignee_id=$2 AND status NOT IN ('completed','cancelled')
         UNION ALL SELECT 'risk',id::text FROM risks WHERE tenant_id=$1 AND owner_id=$2 AND status NOT IN ('closed','accepted')
         UNION ALL SELECT 'issue',id::text FROM issues WHERE tenant_id=$1 AND owner_id=$2 AND status NOT IN ('resolved','closed')
         UNION ALL SELECT 'action_item',id::text FROM action_items WHERE tenant_id=$1 AND owner_id=$2 AND status NOT IN ('completed','cancelled')
         UNION ALL SELECT 'approval',id::text FROM approvals WHERE tenant_id=$1 AND approver_id=$2 AND status='pending'
         UNION ALL SELECT 'responsibility',id::text FROM responsibility_assignments WHERE tenant_id=$1 AND subject_type='user' AND subject_id=$2 AND ends_at IS NULL`,
        [item.tenantId,item.subjectUserId],
      );
      if (item.changeType === "departure" && ownerships.length > 0 && !item.successorUserId) throw new Error("ORGANIZATION_CHANGE_SUCCESSOR_REQUIRED");
      if (item.successorUserId) {
        for (const entry of ownerships) await this.transferOwnership(executor, item, entry.resource_type, entry.resource_id);
      }
      if (item.changeType === "departure") await executor.query("UPDATE users SET status='departed',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [item.tenantId,item.subjectUserId]);
      if (item.changeType === "departure") await executor.query("UPDATE memberships SET ends_at=LEAST(COALESCE(ends_at,$3),$3),updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND starts_at<$3", [item.tenantId,item.subjectUserId,item.executedAt!]);
      else await executor.query("UPDATE memberships SET org_unit_id=$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND ends_at IS NULL", [item.tenantId,item.subjectUserId,item.toOrgUnitId!]);
      await executor.query("UPDATE user_roles SET expires_at=LEAST(COALESCE(expires_at,$3),$3) WHERE tenant_id=$1 AND user_id=$2 AND starts_at<$3", [item.tenantId,item.subjectUserId,item.executedAt!]);
      await executor.query("UPDATE delegations SET revoked_at=COALESCE(revoked_at,$3) WHERE tenant_id=$1 AND (delegator_id=$2 OR delegate_id=$2)", [item.tenantId,item.subjectUserId,item.executedAt!]);
      if (item.changeType === "departure") await executor.query("UPDATE client_devices SET status='revoked',push_enabled=false,revoked_at=COALESCE(revoked_at,$3),version=version+1 WHERE tenant_id=$1 AND user_id=$2 AND status<>'revoked'", [item.tenantId,item.subjectUserId,item.executedAt!]);
      if (item.changeType === "departure") await executor.query("UPDATE external_identities SET status='revoked',updated_at=now() WHERE tenant_id=$1 AND internal_subject_type='user' AND internal_subject_id=$2", [item.tenantId,item.subjectUserId]);
      const handoffs: WorkHandoff[] = [];
      for (const entry of item.successorUserId ? ownerships : []) {
        const handoff: WorkHandoff = { id: randomUUID(), tenantId:item.tenantId, organizationChangeId:item.id, resourceType:entry.resource_type, resourceId:entry.resource_id, fromUserId:item.subjectUserId, toUserId:item.successorUserId!, status:"transferred", evidenceRef:`organization-change:${item.id}`, transferredAt:item.executedAt!, version:1 };
        await executor.query("INSERT INTO work_handoffs(id,tenant_id,organization_change_id,resource_type,resource_id,from_user_id,to_user_id,status,evidence_ref,transferred_at,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [handoff.id,handoff.tenantId,handoff.organizationChangeId,handoff.resourceType,handoff.resourceId,handoff.fromUserId,handoff.toUserId,handoff.status,handoff.evidenceRef,handoff.transferredAt,handoff.version]);
        handoffs.push(handoff);
      }
      return handoffs;
    });
  }

  async getProject(tenantId: string, id: string) { return this.one(tenantId, "SELECT * FROM projects WHERE tenant_id=$1 AND id=$2", id, mapProject); }
  async getProjectChange(tenantId: string, id: string) { return this.one(tenantId, "SELECT * FROM project_change_requests WHERE tenant_id=$1 AND id=$2", id, mapProjectChange); }
  async saveProjectChange(item: ProjectChangeRequest, expectedVersion?: number) {
    return this.database.withTenant(item.tenantId, async (executor) => {
      if (expectedVersion === undefined) {
        const rows=await executor.query("INSERT INTO project_change_requests(id,tenant_id,project_id,change_type,baseline_before,proposed_baseline,reason,impact_assessment,requested_by,approved_by,status,applied_project_version,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id", [item.id,item.tenantId,item.projectId,item.changeType,item.baselineBefore,item.proposedBaseline,item.reason,item.impactAssessment,item.requestedBy,item.approvedBy??null,item.status,item.appliedProjectVersion??null,item.version]); return rows.length===1;
      }
      const rows=await executor.query("UPDATE project_change_requests SET approved_by=$3,status=$4,applied_project_version=$5,version=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$7 RETURNING id",[item.tenantId,item.id,item.approvedBy??null,item.status,item.appliedProjectVersion??null,item.version,expectedVersion]);return rows.length===1;
    });
  }

  async applyProjectChange(item: ProjectChangeRequest, baseline: ProjectBaseline, compensation: CompensationPlan) {
    return this.database.withTenant(item.tenantId, async (executor) => {
      const project=await executor.query("UPDATE projects SET name=$3,description=$4,business_value=$5,acceptance_criteria=$6,resource_plan=$7,starts_at=$8,target_end_at=$9,budget=$10,currency=$11,baseline_version=$12,version=$13,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$14 RETURNING id",[item.tenantId,item.projectId,baseline.name,baseline.description,baseline.businessValue,baseline.acceptanceCriteria,baseline.resourcePlan,baseline.startsAt,baseline.targetEndAt,baseline.budget??null,baseline.currency??null,baseline.baselineVersion,baseline.projectVersion,item.baselineBefore.projectVersion]);
      if(project.length!==1)return false;
      const change=await executor.query("UPDATE project_change_requests SET status='applied',applied_project_version=$3,version=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='approved' AND version=$5 RETURNING id",[item.tenantId,item.id,item.appliedProjectVersion!,item.version,item.version-1]);
      if(change.length!==1)throw new Error("PROJECT_CHANGE_VERSION_CONFLICT");
      await executor.query("INSERT INTO compensation_plans(id,tenant_id,source_operation_type,source_operation_id,resource_type,resource_id,inverse_payload,expected_resource_version,risk_level,status,expires_at,version) VALUES($1,$2,'project_change',$3,'project',$4,$5,$6,3,'ready',$7,1)",[compensation.id,compensation.tenantId,compensation.sourceOperationId,compensation.resourceId,compensation.inversePayload,compensation.expectedResourceVersion,compensation.expiresAt]);return true;
    });
  }

  async getClosureReview(tenantId:string,projectId:string){return this.one(tenantId,"SELECT * FROM project_closure_reviews WHERE tenant_id=$1 AND project_id=$2",projectId,mapClosure);}
  async saveClosureReview(item:ProjectClosureReview,expectedVersion?:number){return this.database.withTenant(item.tenantId,async executor=>{if(expectedVersion===undefined){const rows=await executor.query("INSERT INTO project_closure_reviews(id,tenant_id,project_id,delivery_acceptance_ref,unresolved_items,retrospective_ref,owner_id,status,approved_by,completed_at,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id",[item.id,item.tenantId,item.projectId,item.deliveryAcceptanceRef,item.unresolvedItems,item.retrospectiveRef,item.ownerId,item.status,item.approvedBy??null,item.completedAt??null,item.version]);return rows.length===1;}const rows=await executor.query("UPDATE project_closure_reviews SET delivery_acceptance_ref=$3,unresolved_items=$4,retrospective_ref=$5,status=$6,approved_by=$7,completed_at=$8,version=$9,updated_at=now() WHERE tenant_id=$1 AND project_id=$2 AND version=$10 RETURNING id",[item.tenantId,item.projectId,item.deliveryAcceptanceRef,item.unresolvedItems,item.retrospectiveRef,item.status,item.approvedBy??null,item.completedAt??null,item.version,expectedVersion]);return rows.length===1;});}
  async completeProject(item:ProjectClosureReview,expectedClosureVersion:number,expectedProjectVersion:number){return this.database.withTenant(item.tenantId,async executor=>{const approved=await executor.query("UPDATE project_closure_reviews SET status='approved',approved_by=$3,version=$4,updated_at=now() WHERE tenant_id=$1 AND project_id=$2 AND status='ready' AND version=$5 RETURNING id",[item.tenantId,item.projectId,item.approvedBy!,item.version-1,expectedClosureVersion]);if(approved.length!==1)throw new Error("PROJECT_CLOSURE_VERSION_CONFLICT");const project=await executor.query("UPDATE projects SET status='completed',actual_end_at=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='closing' AND version=$4 RETURNING id",[item.tenantId,item.projectId,item.completedAt!.slice(0,10),expectedProjectVersion]);if(project.length!==1)throw new Error("PROJECT_VERSION_CONFLICT");const review=await executor.query("UPDATE project_closure_reviews SET status='completed',completed_at=$3,version=$4,updated_at=now() WHERE tenant_id=$1 AND project_id=$2 AND status='approved' AND version=$5 RETURNING id",[item.tenantId,item.projectId,item.completedAt!,item.version,item.version-1]);if(review.length!==1)throw new Error("PROJECT_CLOSURE_VERSION_CONFLICT");return true;});}

  async collectAttentionSources(tenantId:string,now:Date):Promise<AttentionSource[]>{return this.database.withTenant(tenantId,async executor=>{const rows=await executor.query<{project_id:string;source_type:AttentionSource["sourceType"];source_id:string;owner_id:string;reason_code:AttentionSource["reasonCode"];severity:AttentionSource["severity"];details:unknown}>(`SELECT project_id,'milestone'::text source_type,id::text source_id,owner_id,'milestone_overdue'::text reason_code,CASE WHEN due_at<$2::date-7 THEN 'critical' ELSE 'at_risk' END::text severity,jsonb_build_object('dueAt',due_at,'status',status) details FROM milestones WHERE tenant_id=$1 AND due_at<$2::date AND status NOT IN ('completed','cancelled')
UNION ALL SELECT project_id,'milestone',id::text,owner_id,'milestone_at_risk','at_risk',jsonb_build_object('dueAt',due_at) FROM milestones WHERE tenant_id=$1 AND status='at_risk'
UNION ALL SELECT project_id,'task',id::text,assignee_id,'critical_task_blocked','critical',jsonb_build_object('dueAt',due_at) FROM tasks WHERE tenant_id=$1 AND status='blocked' AND priority='critical'
UNION ALL SELECT project_id,'risk',id::text,owner_id,'risk_exposure',CASE WHEN exposure>=20 THEN 'critical' ELSE 'at_risk' END,jsonb_build_object('exposure',exposure) FROM risks WHERE tenant_id=$1 AND exposure>=12 AND status NOT IN ('closed','accepted')
UNION ALL SELECT project_id,'action_item',id::text,owner_id,'action_overdue',CASE WHEN due_at<$2-interval '7 days' THEN 'critical' ELSE 'at_risk' END,jsonb_build_object('dueAt',due_at) FROM action_items WHERE tenant_id=$1 AND due_at<$2 AND status NOT IN ('completed','cancelled')
UNION ALL SELECT id,'budget',id::text,owner_id,'budget_variance','critical',jsonb_build_object('budget',budget,'actualCost',(resource_plan->>'actualCost')::numeric) FROM projects WHERE tenant_id=$1 AND budget IS NOT NULL AND resource_plan ? 'actualCost' AND (resource_plan->>'actualCost')::numeric>budget`,[tenantId,now]);return rows.map(row=>({projectId:text(row.project_id),sourceType:row.source_type,sourceId:text(row.source_id),ownerId:text(row.owner_id),reasonCode:row.reason_code,severity:row.severity,details:json<Record<string,unknown>>(row.details)}));});}
  async upsertAttentionItems(tenantId:string,items:ManagementAttentionItem[]){await this.database.withTenant(tenantId,async executor=>{for(const item of items)await executor.query(`INSERT INTO management_attention_items(id,tenant_id,project_id,source_type,source_id,reason_code,severity,owner_id,details,status,detected_at,dedupe_key,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11,1)
ON CONFLICT(tenant_id,dedupe_key) DO UPDATE SET severity=EXCLUDED.severity,owner_id=EXCLUDED.owner_id,details=EXCLUDED.details,status='open',detected_at=EXCLUDED.detected_at,resolved_at=NULL,version=management_attention_items.version+1,updated_at=now()`,[item.id,item.tenantId,item.projectId,item.sourceType,item.sourceId,item.reasonCode,item.severity,item.ownerId,item.details,item.detectedAt,item.dedupeKey]);});}
  async getCompensationPlan(tenantId:string,id:string){return this.one(tenantId,"SELECT * FROM compensation_plans WHERE tenant_id=$1 AND id=$2",id,mapCompensation);}
  async executeCompensation(item:CompensationPlan){return this.database.withTenant(item.tenantId,async executor=>{const b=item.inversePayload;const project=await executor.query("UPDATE projects SET name=$3,description=$4,business_value=$5,acceptance_criteria=$6,resource_plan=$7,starts_at=$8,target_end_at=$9,budget=$10,currency=$11,baseline_version=baseline_version+1,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$12 RETURNING id",[item.tenantId,item.resourceId,b.name,b.description,b.businessValue,b.acceptanceCriteria,b.resourcePlan,b.startsAt,b.targetEndAt,b.budget??null,b.currency??null,item.expectedResourceVersion]);if(project.length!==1)return false;const plan=await executor.query("UPDATE compensation_plans SET status='executed',executed_by=$3,executed_at=$4,version=$5 WHERE tenant_id=$1 AND id=$2 AND status='ready' AND version=$6 RETURNING id",[item.tenantId,item.id,item.executedBy!,item.executedAt!,item.version,item.version-1]);if(plan.length!==1)throw new Error("COMPENSATION_VERSION_CONFLICT");await executor.query("UPDATE project_change_requests SET status='compensated',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='applied'",[item.tenantId,item.sourceOperationId]);return true;});}

  private async one<T>(tenantId:string,sql:string,id:string,mapper:(row:Row)=>T):Promise<T|null>{return this.database.withTenant(tenantId,async executor=>{const rows=await executor.query(sql,[tenantId,id]);return rows[0]?mapper(rows[0]):null;});}
  private async transferOwnership(executor:DatabaseExecutor,item:OrganizationChangeCase,type:WorkHandoff["resourceType"],id:string){const parameters=[item.tenantId,id,item.successorUserId!];switch(type){case"objective":await executor.query("UPDATE objectives SET owner_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",parameters);break;case"project":await executor.query("UPDATE projects SET owner_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",parameters);break;case"task":await executor.query("UPDATE tasks SET assignee_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",parameters);break;case"risk":await executor.query("UPDATE risks SET owner_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",parameters);break;case"issue":await executor.query("UPDATE issues SET owner_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",parameters);break;case"action_item":await executor.query("UPDATE action_items SET owner_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",parameters);break;case"approval":await executor.query("UPDATE approvals SET approver_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",parameters);break;case"responsibility":await executor.query("UPDATE responsibility_assignments SET subject_id=$3,version=version+1 WHERE tenant_id=$1 AND id=$2",parameters);break;}}
}
