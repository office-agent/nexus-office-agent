import { createHash, randomUUID } from "node:crypto";

const eventProviders = ["feishu", "dingtalk", "wecom", "internal"] as const;

export type UnifiedEvent = {
  eventId: string;
  provider: (typeof eventProviders)[number];
  connectionId: string;
  tenantId: string;
  eventType: string;
  occurredAt: string;
  externalActor?: { type: string; id: string };
  externalContext?: Record<string, string>;
  payload: Record<string, unknown>;
  rawDigest: string;
  schemaVersion: number;
  traceId: string;
};

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${field} must be a${allowEmpty ? "" : " non-empty"} string`);
  }
  return value;
}

function parseUnifiedEvent(input: unknown): UnifiedEvent {
  const value = asRecord(input, "event");
  const provider = asString(value.provider, "provider");
  if (!(eventProviders as readonly string[]).includes(provider)) {
    throw new TypeError("provider is not supported");
  }

  const occurredAt = asString(value.occurredAt, "occurredAt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt) ||
    Number.isNaN(Date.parse(occurredAt))
  ) {
    throw new TypeError("occurredAt must be an ISO 8601 datetime with an offset");
  }

  const rawDigest = asString(value.rawDigest, "rawDigest");
  if (!/^[a-fA-F0-9]{64}$/.test(rawDigest)) {
    throw new TypeError("rawDigest must be a 64-character hexadecimal digest");
  }

  if (!Number.isInteger(value.schemaVersion) || (value.schemaVersion as number) <= 0) {
    throw new TypeError("schemaVersion must be a positive integer");
  }

  let externalActor: UnifiedEvent["externalActor"];
  if (value.externalActor !== undefined) {
    const actor = asRecord(value.externalActor, "externalActor");
    externalActor = {
      type: asString(actor.type, "externalActor.type", true),
      id: asString(actor.id, "externalActor.id", true),
    };
  }

  let externalContext: Record<string, string> | undefined;
  if (value.externalContext !== undefined) {
    externalContext = Object.fromEntries(
      Object.entries(asRecord(value.externalContext, "externalContext")).map(([key, entry]) => [
        key,
        asString(entry, `externalContext.${key}`, true),
      ]),
    );
  }

  return {
    eventId: asString(value.eventId, "eventId"),
    provider: provider as UnifiedEvent["provider"],
    connectionId: asString(value.connectionId, "connectionId"),
    tenantId: asString(value.tenantId, "tenantId"),
    eventType: asString(value.eventType, "eventType"),
    occurredAt,
    ...(externalActor ? { externalActor } : {}),
    ...(externalContext ? { externalContext } : {}),
    payload: { ...asRecord(value.payload, "payload") },
    rawDigest: rawDigest.toLowerCase(),
    schemaVersion: value.schemaVersion as number,
    traceId: asString(value.traceId, "traceId"),
  };
}

// This small parse-compatible facade keeps event validation deterministic and
// free of import-time schema construction in server bundles.
export const unifiedEventSchema = { parse: parseUnifiedEvent } as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function digestPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

export function deriveExternalEventId(input: {
  provider: string;
  connectionId: string;
  eventType: string;
  occurredAt: string;
  stableFields: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}

export type DomainEvent<T extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  type: string;
  version: number;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  actor: { type: "user" | "agent" | "system"; id: string };
  traceId: string;
  causationId?: string;
  correlationId?: string;
  payload: T;
};

export function createDomainEvent<T extends Record<string, unknown>>(
  input: Omit<DomainEvent<T>, "id" | "occurredAt"> & Partial<Pick<DomainEvent<T>, "id" | "occurredAt">>,
): DomainEvent<T> {
  return { ...input, id: input.id ?? randomUUID(), occurredAt: input.occurredAt ?? new Date().toISOString() };
}
