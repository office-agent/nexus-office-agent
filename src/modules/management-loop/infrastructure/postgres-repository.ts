import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type { ManagementLoopRepository, ManagementSnapshot } from "@/src/modules/management-loop/application/contracts";
import type { Objective } from "@/src/modules/strategy/domain/objective";
import type { Project } from "@/src/modules/delivery/domain/project";
import type { Milestone } from "@/src/modules/delivery/domain/milestone";
import type { DeliveryTask } from "@/src/modules/delivery/domain/task";
import type { Risk } from "@/src/modules/governance/domain/risk";
import type { Issue } from "@/src/modules/governance/domain/issue";
import type { Decision } from "@/src/modules/governance/domain/decision";
import type { ActionItem } from "@/src/modules/collaboration/domain/action-item";
import type { DomainEvent } from "@/src/modules/events/domain/event-envelope";

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function mapObjective(row: Row): Objective {
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    title: text(row.title),
    description: text(row.description),
    ownerId: text(row.owner_id),
    status: row.status as Objective["status"],
    baseline: numberOrUndefined(row.baseline),
    targetValue: numberOrUndefined(row.target_value),
    currentValue: numberOrUndefined(row.current_value),
    unit: optionalText(row.unit),
    startsAt: text(row.starts_at).slice(0, 10),
    endsAt: text(row.ends_at).slice(0, 10),
    reviewCadence: row.review_cadence as Objective["reviewCadence"],
    version: Number(row.version),
  };
}

function mapProject(row: Row): Project {
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    code: text(row.code),
    name: text(row.name),
    description: text(row.description),
    ownerId: text(row.owner_id),
    sponsorId: optionalText(row.sponsor_id),
    status: row.status as Project["status"],
    priority: row.priority as Project["priority"],
    startsAt: text(row.starts_at).slice(0, 10),
    targetEndAt: text(row.target_end_at).slice(0, 10),
    health: row.health as Project["health"],
    version: Number(row.version),
  };
}

function mapMilestone(row: Row): Milestone {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), projectId: text(row.project_id), name: text(row.name),
    ownerId: text(row.owner_id), dueAt: text(row.due_at).slice(0, 10), status: row.status as Milestone["status"],
    acceptanceCriteria: text(row.acceptance_criteria), completedAt: optionalText(row.completed_at), version: Number(row.version),
  };
}

function mapTask(row: Row): DeliveryTask {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), projectId: text(row.project_id),
    milestoneId: optionalText(row.milestone_id), parentId: optionalText(row.parent_id), title: text(row.title),
    description: text(row.description), assigneeId: text(row.assignee_id), status: row.status as DeliveryTask["status"],
    priority: row.priority as DeliveryTask["priority"], dueAt: optionalText(row.due_at),
    completedAt: optionalText(row.completed_at), version: Number(row.version),
  };
}

function mapRisk(row: Row): Risk {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), projectId: text(row.project_id), title: text(row.title),
    description: text(row.description), ownerId: text(row.owner_id), probability: Number(row.probability) as Risk["probability"],
    impact: Number(row.impact) as Risk["impact"], status: row.status as Risk["status"],
    responseStrategy: row.response_strategy as Risk["responseStrategy"], responsePlan: optionalText(row.response_plan),
    reviewAt: optionalText(row.review_at), sourceType: row.source_type as Risk["sourceType"], sourceRef: optionalText(row.source_ref),
    version: Number(row.version),
  };
}

function mapIssue(row: Row): Issue {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), projectId: text(row.project_id), riskId: optionalText(row.risk_id),
    title: text(row.title), description: text(row.description), ownerId: text(row.owner_id),
    severity: row.severity as Issue["severity"], status: row.status as Issue["status"],
    resolution: optionalText(row.resolution), version: Number(row.version),
  };
}

function mapDecision(row: Row): Decision {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), projectId: optionalText(row.project_id), riskId: optionalText(row.risk_id),
    sourceMeetingId: optionalText(row.source_meeting_id),
    title: text(row.title), context: text(row.context), options: row.options as string[], selectedOption: optionalText(row.selected_option),
    rationale: optionalText(row.rationale), ownerId: text(row.owner_id), decidedBy: optionalText(row.decided_by),
    status: row.status as Decision["status"], reviewAt: optionalText(row.review_at), supersedesId: optionalText(row.supersedes_id),
    version: Number(row.version),
  };
}

function mapActionItem(row: Row): ActionItem {
  return {
    id: text(row.id), tenantId: text(row.tenant_id), decisionId: optionalText(row.decision_id), projectId: optionalText(row.project_id),
    title: text(row.title), description: text(row.description), ownerId: text(row.owner_id), dueAt: text(row.due_at),
    acceptanceCriteria: text(row.acceptance_criteria), status: row.status as ActionItem["status"],
    completedAt: optionalText(row.completed_at), completionEvidence: optionalText(row.completion_evidence), version: Number(row.version),
  };
}

async function insertOutbox(executor: DatabaseExecutor, event: DomainEvent): Promise<void> {
  await executor.query(
    `INSERT INTO outbox_events(id,tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload,trace_id,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
    [event.id,event.tenantId,event.type,event.aggregateType,event.aggregateId,event.aggregateVersion,event.payload,event.traceId,event.occurredAt],
  );
}

export class PostgresManagementLoopRepository implements ManagementLoopRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getSnapshot(tenantId: string, projectId: string): Promise<ManagementSnapshot | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const projects = await executor.query("SELECT * FROM projects WHERE tenant_id=$1 AND id=$2", [tenantId, projectId]);
      if (projects.length === 0) return null;
      const objectives = await executor.query(
        "SELECT o.* FROM objectives o JOIN objective_project_links l ON l.objective_id=o.id AND l.tenant_id=o.tenant_id WHERE l.tenant_id=$1 AND l.project_id=$2 ORDER BY l.contribution_weight DESC LIMIT 1",
        [tenantId, projectId],
      );
      if (objectives.length === 0) throw new Error("PROJECT_OBJECTIVE_LINK_REQUIRED");
      const [milestones, tasks, risks, issues, decisions, actionItems] = await Promise.all([
        executor.query("SELECT * FROM milestones WHERE tenant_id=$1 AND project_id=$2 ORDER BY due_at,id", [tenantId, projectId]),
        executor.query("SELECT * FROM tasks WHERE tenant_id=$1 AND project_id=$2 ORDER BY due_at NULLS LAST,id", [tenantId, projectId]),
        executor.query("SELECT * FROM risks WHERE tenant_id=$1 AND project_id=$2 ORDER BY exposure DESC,id", [tenantId, projectId]),
        executor.query("SELECT * FROM issues WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at,id", [tenantId, projectId]),
        executor.query("SELECT * FROM decisions WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at,id", [tenantId, projectId]),
        executor.query("SELECT * FROM action_items WHERE tenant_id=$1 AND project_id=$2 ORDER BY due_at,id", [tenantId, projectId]),
      ]);
      return {
        objective: mapObjective(objectives[0]), project: mapProject(projects[0]), milestones: milestones.map(mapMilestone),
        tasks: tasks.map(mapTask), risks: risks.map(mapRisk), issues: issues.map(mapIssue), decisions: decisions.map(mapDecision),
        actionItems: actionItems.map(mapActionItem), generatedAt: new Date().toISOString(),
      };
    });
  }

  async getRisk(tenantId: string, id: string): Promise<Risk | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM risks WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapRisk(rows[0]) : null;
    });
  }

  async saveRisk(risk: Risk, event: DomainEvent): Promise<void> {
    await this.database.withTenant(risk.tenantId, async (executor) => {
      await executor.query(
      `INSERT INTO risks(id,tenant_id,project_id,title,description,owner_id,probability,impact,status,response_strategy,response_plan,review_at,source_type,source_ref,version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,owner_id=EXCLUDED.owner_id,probability=EXCLUDED.probability,impact=EXCLUDED.impact,status=EXCLUDED.status,response_strategy=EXCLUDED.response_strategy,response_plan=EXCLUDED.response_plan,review_at=EXCLUDED.review_at,source_type=EXCLUDED.source_type,source_ref=EXCLUDED.source_ref,version=EXCLUDED.version,updated_at=now()`,
      [risk.id,risk.tenantId,risk.projectId,risk.title,risk.description,risk.ownerId,risk.probability,risk.impact,risk.status,risk.responseStrategy ?? null,risk.responsePlan ?? null,risk.reviewAt ?? null,risk.sourceType,risk.sourceRef ?? null,risk.version],
      );
      await insertOutbox(executor, event);
    });
  }

  async saveDecision(decision: Decision, actionItems: ActionItem[], event: DomainEvent): Promise<void> {
    await this.database.withTenant(decision.tenantId, async (executor) => {
      if (!decision.projectId) throw new Error("DECISION_PROJECT_REQUIRED");
      const projects = await executor.query("SELECT id FROM projects WHERE tenant_id=$1 AND id=$2", [decision.tenantId,decision.projectId]);
      if (projects.length !== 1) throw new Error("PROJECT_NOT_FOUND");
      if (decision.riskId) {
        const risks = await executor.query("SELECT id FROM risks WHERE tenant_id=$1 AND id=$2 AND project_id=$3", [decision.tenantId,decision.riskId,decision.projectId]);
        if (risks.length !== 1) throw new Error("RISK_PROJECT_MISMATCH");
      }
      if (decision.sourceMeetingId) {
        const meetings = await executor.query(
          "SELECT id FROM meeting_records WHERE tenant_id=$1 AND id=$2 AND project_id=$3",
          [decision.tenantId,decision.sourceMeetingId,decision.projectId],
        );
        if (meetings.length !== 1) throw new Error("MEETING_PROJECT_MISMATCH");
      }
      await executor.query(
      `INSERT INTO decisions(id,tenant_id,project_id,risk_id,source_meeting_id,title,context,options,selected_option,rationale,owner_id,decided_by,status,review_at,supersedes_id,version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(id) DO UPDATE SET source_meeting_id=EXCLUDED.source_meeting_id,title=EXCLUDED.title,context=EXCLUDED.context,options=EXCLUDED.options,selected_option=EXCLUDED.selected_option,rationale=EXCLUDED.rationale,owner_id=EXCLUDED.owner_id,decided_by=EXCLUDED.decided_by,status=EXCLUDED.status,review_at=EXCLUDED.review_at,supersedes_id=EXCLUDED.supersedes_id,version=EXCLUDED.version,updated_at=now()`,
      [decision.id,decision.tenantId,decision.projectId ?? null,decision.riskId ?? null,decision.sourceMeetingId ?? null,decision.title,decision.context,decision.options,decision.selectedOption ?? null,decision.rationale ?? null,decision.ownerId,decision.decidedBy ?? null,decision.status,decision.reviewAt ?? null,decision.supersedesId ?? null,decision.version],
      );
      for (const item of actionItems) {
        if (item.projectId !== decision.projectId || item.decisionId !== decision.id) throw new Error("ACTION_ITEM_DECISION_MISMATCH");
        await this.insertActionItem(executor, item);
      }
      await insertOutbox(executor, event);
    });
  }

  async getDecision(tenantId: string, id: string): Promise<Decision | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM decisions WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
      return rows[0] ? mapDecision(rows[0]) : null;
    });
  }

  async replaceDecision(original: Decision, replacement: Decision, expectedOriginalVersion: number, event: DomainEvent): Promise<boolean> {
    return this.database.withTenant(original.tenantId, async (executor) => {
      const updated = await executor.query(
        "UPDATE decisions SET status='superseded',version=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$4 AND status IN ('decided','executing','verified') RETURNING id",
        [original.tenantId, original.id, original.version, expectedOriginalVersion],
      );
      if (updated.length !== 1) return false;
      await executor.query(
        `INSERT INTO decisions(id,tenant_id,project_id,risk_id,source_meeting_id,title,context,options,selected_option,rationale,owner_id,decided_by,status,review_at,supersedes_id,version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [replacement.id,replacement.tenantId,replacement.projectId ?? null,replacement.riskId ?? null,replacement.sourceMeetingId ?? null,replacement.title,replacement.context,replacement.options,replacement.selectedOption!,replacement.rationale!,replacement.ownerId,replacement.decidedBy!,replacement.status,replacement.reviewAt ?? null,replacement.supersedesId!,replacement.version],
      );
      await insertOutbox(executor, event);
      return true;
    });
  }

  async getActionItem(tenantId: string, id: string): Promise<ActionItem | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM action_items WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapActionItem(rows[0]) : null;
    });
  }

  async saveActionItem(item: ActionItem, expectedVersion: number, event: DomainEvent): Promise<boolean> {
    return this.database.withTenant(item.tenantId, async (executor) => {
      const rows = await executor.query(
        `UPDATE action_items SET status=$3,completed_at=$4,completion_evidence=$5,version=$6,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND version=$7 AND status IN ('open','in_progress','blocked') RETURNING id`,
        [item.tenantId,item.id,item.status,item.completedAt ?? null,item.completionEvidence ?? null,item.version,expectedVersion],
      );
      if (rows.length !== 1) return false;
      await insertOutbox(executor, event);
      return true;
    });
  }

  async getTask(tenantId: string, id: string): Promise<DeliveryTask | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM tasks WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapTask(rows[0]) : null;
    });
  }

  async saveTask(task: DeliveryTask, expectedVersion: number, event: DomainEvent): Promise<boolean> {
    return this.database.withTenant(task.tenantId, async (executor) => {
      const rows = await executor.query(
        `UPDATE tasks SET status=$3,completed_at=$4,version=$5,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND version=$6 RETURNING id`,
        [task.tenantId,task.id,task.status,task.completedAt ?? null,task.version,expectedVersion],
      );
      if (rows.length !== 1) return false;
      await insertOutbox(executor, event);
      return true;
    });
  }

  async saveIssue(issue: Issue, event: DomainEvent): Promise<void> {
    await this.database.withTenant(issue.tenantId, async (executor) => {
      await executor.query(
      `INSERT INTO issues(id,tenant_id,project_id,risk_id,title,description,owner_id,severity,status,resolution,version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,owner_id=EXCLUDED.owner_id,severity=EXCLUDED.severity,status=EXCLUDED.status,resolution=EXCLUDED.resolution,version=EXCLUDED.version,updated_at=now()`,
      [issue.id,issue.tenantId,issue.projectId,issue.riskId ?? null,issue.title,issue.description,issue.ownerId,issue.severity,issue.status,issue.resolution ?? null,issue.version],
      );
      await insertOutbox(executor, event);
    });
  }

  private async insertActionItem(executor: DatabaseExecutor, item: ActionItem): Promise<void> {
    await executor.query(
      `INSERT INTO action_items(id,tenant_id,decision_id,project_id,title,description,owner_id,due_at,acceptance_criteria,status,completed_at,completion_evidence,version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,owner_id=EXCLUDED.owner_id,due_at=EXCLUDED.due_at,acceptance_criteria=EXCLUDED.acceptance_criteria,status=EXCLUDED.status,completed_at=EXCLUDED.completed_at,completion_evidence=EXCLUDED.completion_evidence,version=EXCLUDED.version,updated_at=now()`,
      [item.id,item.tenantId,item.decisionId ?? null,item.projectId ?? null,item.title,item.description,item.ownerId,item.dueAt,item.acceptanceCriteria,item.status,item.completedAt ?? null,item.completionEvidence ?? null,item.version],
    );
  }
}
