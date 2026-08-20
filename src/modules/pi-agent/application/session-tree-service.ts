import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiSession, PiSessionEvent, PiSessionStore } from "@/src/modules/pi-agent/domain/contracts";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { sha256, stableJson } from "@/src/modules/pi-agent/application/manifest";
import type {
  PiCompactInput,
  PiContextCompactionInput,
  PiContextCompactionOutput,
  PiContextCompactor,
  PiContextSummary,
  PiForkInput,
  PiSessionBranch,
  PiSessionHistory,
  PiSessionTree,
  PiSessionTreeServiceDependencies,
} from "@/src/modules/pi-agent/domain/session-tree-contracts";

function now(): string { return new Date().toISOString(); }

function idempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 256) throw new Error("PI_IDEMPOTENCY_KEY_REQUIRED");
  return key;
}

function safeLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > 100 || !/^[\p{L}\p{N}._ -]+$/u.test(label)) throw new Error("PI_SESSION_BRANCH_LABEL_INVALID");
  return label;
}

function safeEventProjection(event: PiSessionEvent): Record<string, unknown> {
  return { id: event.id, sequence: event.sequence, type: event.type, branchId: event.branchId ?? null, traceId: event.traceId };
}

function continuityDigest(branches: PiSessionBranch[], summaries: PiContextSummary[], events: PiSessionEvent[] = []): string {
  return sha256(stableJson({
    branches: branches.map((branch) => ({ id: branch.id, parentBranchId: branch.parentBranchId ?? null, baseEventSequence: branch.baseEventSequence, headEventSequence: branch.headEventSequence, version: branch.version, status: branch.status })).sort((left, right) => left.id.localeCompare(right.id)),
    summaries: summaries.map((summary) => ({ id: summary.id, branchId: summary.branchId, sourceStartSequence: summary.sourceStartSequence, sourceEndSequence: summary.sourceEndSequence, summaryDigest: summary.summaryDigest, compactionVersion: summary.compactionVersion })).sort((left, right) => left.id.localeCompare(right.id)),
    events: events.map(safeEventProjection),
  }));
}

export class DeterministicPiContextCompactor implements PiContextCompactor {
  async compact(input: PiContextCompactionInput): Promise<PiContextCompactionOutput> {
    if (input.events.length === 0) throw new Error("PI_CONTEXT_COMPACTION_NO_NEW_EVENTS");
    const ordered = [...input.events].sort((left, right) => left.sequence - right.sequence);
    return {
      sourceStartSequence: ordered[0].sequence,
      sourceEndSequence: ordered[ordered.length - 1].sequence,
      sourceEventIds: ordered.map((event) => event.id),
      eventTypes: [...new Set(ordered.map((event) => event.type))].sort(),
      summary: {
        kind: "deterministic-event-summary",
        sessionId: input.session.id,
        branchId: input.branch.id,
        sourceStartSequence: ordered[0].sequence,
        sourceEndSequence: ordered[ordered.length - 1].sequence,
        eventCount: ordered.length,
        eventTypes: [...new Set(ordered.map((event) => event.type))].sort(),
        previousSummaryDigest: input.previousSummary?.summaryDigest ?? null,
        sourceEventDigests: ordered.map((event) => sha256(stableJson(safeEventProjection(event)))),
      },
    };
  }
}

export class SessionTreeService {
  private readonly sessionStore: PiSessionStore;
  private readonly treeStore: PiSessionTreeServiceDependencies["treeStore"];
  private readonly compactor: PiContextCompactor;

  constructor(dependencies: PiSessionTreeServiceDependencies) {
    this.sessionStore = dependencies.sessionStore;
    this.treeStore = dependencies.treeStore;
    this.compactor = dependencies.compactor ?? new DeterministicPiContextCompactor();
  }

  async ensureRoot(context: RequestContext, sessionId: string): Promise<PiSessionBranch> {
    const session = await this.requireSession(context, sessionId);
    const existing = (await this.treeStore.listBranches(context, sessionId)).find((branch) => !branch.parentBranchId);
    if (existing) return existing;
    const created: PiSessionBranch = {
      id: randomUUID(),
      tenantId: context.tenantId,
      sessionId,
      baseEventSequence: 0,
      headEventSequence: session.lastEventSequence,
      label: "main",
      status: "active",
      version: 1,
      idempotencyKey: `root:${sessionId}`,
      createdBy: context.actorId,
      createdAt: now(),
      updatedAt: now(),
    };
    try {
      return await this.treeStore.createBranch(created);
    } catch (error) {
      if (error instanceof Error && (error.message === "PI_SESSION_BRANCH_IDEMPOTENCY_CONFLICT" || error.message === "PI_SESSION_BRANCH_DUPLICATE")) {
        const raced = (await this.treeStore.listBranches(context, sessionId)).find((branch) => !branch.parentBranchId);
        if (raced) return raced;
      }
      throw error;
    }
  }

  async getTree(context: RequestContext, sessionId: string): Promise<PiSessionTree> {
    assertPiPermission(context, "pi:session:read");
    const session = await this.requireSession(context, sessionId);
    const rootBranch = await this.ensureRoot(context, sessionId);
    const branches = await this.treeStore.listBranches(context, sessionId);
    const summaries = await this.treeStore.listSummaries(context, sessionId);
    return { session, rootBranch, branches, summaries, continuityDigest: continuityDigest(branches, summaries) };
  }

  async fork(context: RequestContext, sessionId: string, input: PiForkInput): Promise<PiSessionBranch> {
    assertPiPermission(context, "pi:session:branch");
    const session = await this.requireSession(context, sessionId);
    const key = idempotencyKey(input.idempotencyKey);
    const existing = await this.treeStore.findBranchByIdempotency(context, sessionId, key);
    if (existing) return existing;
    const root = await this.ensureRoot(context, sessionId);
    const parent = input.parentBranchId ? await this.treeStore.getBranch(context, sessionId, input.parentBranchId) : root;
    if (!parent) throw new Error("PI_SESSION_BRANCH_NOT_FOUND");
    if (parent.status !== "active") throw new Error("PI_SESSION_BRANCH_NOT_ACTIVE");
    if (input.expectedParentVersion !== undefined && input.expectedParentVersion !== parent.version) throw new Error("PI_SESSION_BRANCH_VERSION_CONFLICT");
    let checkpointSequence: number | undefined;
    if (input.checkpointId) {
      const checkpoint = (await this.sessionStore.listCheckpoints(context, sessionId)).find((item) => item.id === input.checkpointId);
      if (!checkpoint) throw new Error("PI_CHECKPOINT_NOT_FOUND");
      const snapshot = checkpoint.snapshot && typeof checkpoint.snapshot === "object" ? checkpoint.snapshot as Record<string, unknown> : {};
      checkpointSequence = typeof snapshot.eventSequence === "number" && Number.isSafeInteger(snapshot.eventSequence) ? snapshot.eventSequence : parent.headEventSequence;
    }
    const baseEventSequence = input.baseEventSequence ?? checkpointSequence ?? parent.headEventSequence;
    if (!Number.isSafeInteger(baseEventSequence) || baseEventSequence < parent.baseEventSequence || baseEventSequence > session.lastEventSequence) throw new Error("PI_SESSION_BRANCH_BASE_INVALID");
    const branch: PiSessionBranch = {
      id: randomUUID(),
      tenantId: context.tenantId,
      sessionId,
      parentBranchId: parent.id,
      baseEventSequence,
      headEventSequence: baseEventSequence,
      label: safeLabel(input.label),
      status: "active",
      version: 1,
      idempotencyKey: key,
      createdBy: context.actorId,
      createdAt: now(),
      updatedAt: now(),
    };
    const created = await this.treeStore.createBranch(branch);
    try {
      const event = await this.sessionStore.appendEvent(context, sessionId, {
        type: "pi.session.branch_created",
        branchId: parent.id,
        payload: {
          branchId: created.id,
          parentBranchId: parent.id,
          baseEventSequence,
          label: created.label,
          idempotencyKeyDigest: sha256(key),
        },
        traceId: context.traceId,
      });
      await this.treeStore.updateBranch(context, parent.id, parent.version, { headEventSequence: Math.max(parent.headEventSequence, event.sequence) });
    } catch (error) {
      throw error;
    }
    return created;
  }

  async materializeHistory(context: RequestContext, sessionId: string, branchId?: string): Promise<PiSessionHistory> {
    assertPiPermission(context, "pi:session:read");
    const session = await this.requireSession(context, sessionId);
    const root = await this.ensureRoot(context, sessionId);
    const branch = branchId ? await this.treeStore.getBranch(context, sessionId, branchId) : root;
    if (!branch) throw new Error("PI_SESSION_BRANCH_NOT_FOUND");
    const events = await this.readAllEvents(context, sessionId);
    const branchEvents = events.filter((event) => event.sequence <= branch.baseEventSequence || event.branchId === branch.id || (branch.id === root.id && !event.branchId));
    const summaries = await this.treeStore.listSummaries(context, sessionId, branch.id);
    const checkpoints = await this.sessionStore.listCheckpoints(context, sessionId);
    const ordered = branchEvents.sort((left, right) => left.sequence - right.sequence);
    this.assertContinuity(ordered, branch);
    return { session, branch, events: ordered, checkpoints, summaries, continuityDigest: continuityDigest([branch], summaries, ordered) };
  }

  async resume(context: RequestContext, sessionId: string, branchId?: string): Promise<PiSessionHistory> {
    assertPiPermission(context, "pi:session:write");
    return this.materializeHistory(context, sessionId, branchId);
  }

  async compact(context: RequestContext, sessionId: string, input: PiCompactInput): Promise<PiContextSummary> {
    assertPiPermission(context, "pi:session:write");
    const key = idempotencyKey(input.idempotencyKey);
    const root = await this.ensureRoot(context, sessionId);
    const branch = input.branchId ? await this.treeStore.getBranch(context, sessionId, input.branchId) : root;
    if (!branch) throw new Error("PI_SESSION_BRANCH_NOT_FOUND");
    if (branch.status !== "active") throw new Error("PI_SESSION_BRANCH_NOT_ACTIVE");
    if (input.expectedBranchVersion !== undefined && input.expectedBranchVersion !== branch.version) throw new Error("PI_SESSION_BRANCH_VERSION_CONFLICT");
    const existing = await this.treeStore.findSummaryByIdempotency(context, sessionId, branch.id, key);
    if (existing) return existing;
    const history = await this.materializeHistory(context, sessionId, branch.id);
    const previous = (await this.treeStore.listSummaries(context, sessionId, branch.id)).at(-1);
    const start = (previous?.sourceEndSequence ?? branch.baseEventSequence) + 1;
    const maxEvents = Math.min(Math.max(input.maxEvents ?? 500, 1), 500);
    const sourceEvents = history.events.filter((event) => event.sequence >= start).slice(0, maxEvents);
    const output = await this.compactor.compact({ session: history.session, branch, events: sourceEvents, previousSummary: previous, createdBy: context.actorId });
    const summary: PiContextSummary = {
      id: randomUUID(),
      tenantId: context.tenantId,
      sessionId,
      branchId: branch.id,
      sourceStartSequence: output.sourceStartSequence,
      sourceEndSequence: output.sourceEndSequence,
      sourceEventIds: output.sourceEventIds,
      eventTypes: output.eventTypes,
      summary: output.summary,
      summaryDigest: sha256(stableJson(output.summary)),
      compactionVersion: (previous?.compactionVersion ?? 0) + 1,
      idempotencyKey: key,
      createdBy: context.actorId,
      createdAt: now(),
    };
    const created = await this.treeStore.createSummary(summary);
    const event = await this.sessionStore.appendEvent(context, sessionId, {
      type: "pi.context.compacted",
      branchId: branch.id,
      payload: { branchId: branch.id, summaryId: created.id, sourceStartSequence: created.sourceStartSequence, sourceEndSequence: created.sourceEndSequence, summaryDigest: created.summaryDigest },
      traceId: context.traceId,
    });
    await this.treeStore.updateBranch(context, branch.id, branch.version, { headEventSequence: Math.max(branch.headEventSequence, event.sequence) });
    return created;
  }

  async verifyContinuity(context: RequestContext, sessionId: string, branchId?: string): Promise<{ valid: true; digest: string } | { valid: false; reason: string }> {
    try {
      const history = await this.materializeHistory(context, sessionId, branchId);
      return { valid: true, digest: history.continuityDigest };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : "PI_SESSION_CONTINUITY_INVALID" };
    }
  }

  private async requireSession(context: RequestContext, sessionId: string): Promise<PiSession> {
    const session = await this.sessionStore.getSession(context, sessionId);
    if (!session) throw new Error("PI_SESSION_NOT_FOUND");
    return session;
  }

  private async readAllEvents(context: RequestContext, sessionId: string): Promise<PiSessionEvent[]> {
    const result: PiSessionEvent[] = [];
    let cursor = 0;
    for (let page = 0; page < 20; page += 1) {
      const rows = await this.sessionStore.getEvents(context, sessionId, cursor, 500);
      result.push(...rows);
      if (rows.length < 500) break;
      const next = rows.at(-1)?.sequence ?? cursor;
      if (next <= cursor) throw new Error("PI_SESSION_EVENT_CURSOR_INVALID");
      cursor = next;
    }
    return result;
  }

  private assertContinuity(events: PiSessionEvent[], branch: PiSessionBranch): void {
    let last = 0;
    for (const event of events) {
      if (event.sequence <= last) throw new Error("PI_SESSION_EVENT_SEQUENCE_INVALID");
      if (event.sequence <= branch.baseEventSequence && event.branchId && event.branchId !== branch.parentBranchId && event.branchId !== branch.id) throw new Error("PI_SESSION_BRANCH_PARENT_MISMATCH");
      last = event.sequence;
    }
  }
}
