import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiCheckpoint, PiSession, PiSessionEvent, PiSessionStore } from "@/src/modules/pi-agent/domain/contracts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryPiSessionStore implements PiSessionStore {
  private readonly sessions = new Map<string, PiSession>();
  private readonly events = new Map<string, PiSessionEvent[]>();
  private readonly checkpoints = new Map<string, PiCheckpoint[]>();

  private key(tenantId: string, sessionId: string): string { return `${tenantId}:${sessionId}`; }

  async createSession(session: PiSession): Promise<void> {
    this.sessions.set(this.key(session.tenantId, session.id), clone(session));
    this.events.set(this.key(session.tenantId, session.id), []);
    this.checkpoints.set(this.key(session.tenantId, session.id), []);
  }

  async getSession(context: RequestContext, sessionId: string): Promise<PiSession | null> {
    const session = this.sessions.get(this.key(context.tenantId, sessionId));
    return session ? clone(session) : null;
  }

  async listSessions(context: RequestContext): Promise<PiSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.tenantId === context.tenantId && session.actorId === context.actorId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async updateSession(context: RequestContext, sessionId: string, patch: Partial<Pick<PiSession, "status" | "lastEventSequence" | "updatedAt">>): Promise<PiSession> {
    const key = this.key(context.tenantId, sessionId);
    const current = this.sessions.get(key);
    if (!current) throw new Error("PI_SESSION_NOT_FOUND");
    const updated = { ...current, ...patch };
    this.sessions.set(key, updated);
    return clone(updated);
  }

  async appendEvent(context: RequestContext, sessionId: string, event: Omit<PiSessionEvent, "id" | "sequence" | "createdAt" | "tenantId" | "sessionId">): Promise<PiSessionEvent> {
    const key = this.key(context.tenantId, sessionId);
    const session = this.sessions.get(key);
    if (!session) throw new Error("PI_SESSION_NOT_FOUND");
    const list = this.events.get(key) ?? [];
    const record: PiSessionEvent = {
      ...event,
      id: randomUUID(),
      tenantId: context.tenantId,
      sessionId,
      sequence: list.length + 1,
      createdAt: new Date().toISOString(),
    };
    list.push(record);
    this.events.set(key, list);
    session.lastEventSequence = record.sequence;
    session.updatedAt = record.createdAt;
    return clone(record);
  }

  async getEvents(context: RequestContext, sessionId: string, afterSequence: number, limit: number): Promise<PiSessionEvent[]> {
    return (this.events.get(this.key(context.tenantId, sessionId)) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map(clone);
  }

  async createCheckpoint(context: RequestContext, checkpoint: PiCheckpoint): Promise<void> {
    const key = this.key(context.tenantId, checkpoint.sessionId);
    if (!this.sessions.has(key)) throw new Error("PI_SESSION_NOT_FOUND");
    this.checkpoints.set(key, [...(this.checkpoints.get(key) ?? []), clone(checkpoint)]);
  }

  async listCheckpoints(context: RequestContext, sessionId: string): Promise<PiCheckpoint[]> {
    return (this.checkpoints.get(this.key(context.tenantId, sessionId)) ?? []).map(clone);
  }
}
