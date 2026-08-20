import { deriveExternalEventId, digestPayload, unifiedEventSchema, type UnifiedEvent } from "@/src/modules/events/domain/event-envelope";
import type { VerifiedRawEvent } from "@/src/modules/integration/domain/connector";

const feishuEventTypes: Record<string, string> = {
  "im.message.receive_v1": "message.received",
  "card.action.trigger": "card.action",
  "contact.user.updated_v3": "user.changed",
  "contact.department.updated_v3": "department.changed",
  "calendar.calendar.event.changed_v4": "meeting.changed",
  "approval.approval.updated_v4": "approval.changed",
};

const dingtalkEventTypes: Record<string, string> = {
  "chatbot.message": "message.received",
  "card.action": "card.action",
  "user.change": "user.changed",
  "org.dept.change": "department.changed",
  "meeting.change": "meeting.changed",
  "approval.change": "approval.changed",
};

function isoTime(value: unknown, fallback: string): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function actor(id: unknown): { type: string; id: string } | undefined {
  const normalized = typeof id === "string" ? id : "";
  return normalized ? { type: "user", id: normalized } : undefined;
}

function compactContext(entries: Record<string, unknown>): Record<string, string> | undefined {
  const context = Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0));
  return Object.keys(context).length > 0 ? context : undefined;
}

function cardPayload(value: Record<string, unknown>): Record<string, unknown> {
  const action = object(value.action);
  const formValue = object(action.value ?? value.value);
  return {
    actionId: String(formValue.action_id ?? formValue.actionId ?? action.tag ?? ""),
    proposalHash: String(formValue.proposal_hash ?? formValue.proposalHash ?? ""),
    expiresAt: String(formValue.expires_at ?? formValue.expiresAt ?? ""),
  };
}

export function normalizeFeishuEvent(raw: VerifiedRawEvent): UnifiedEvent[] {
  if (raw.body.type === "url_verification") return [];
  const header = object(raw.body.header);
  const event = object(raw.body.event);
  const externalType = String(header.event_type ?? raw.body.type ?? "unknown");
  const eventType = feishuEventTypes[externalType] ?? `provider.${externalType}`;
  const sender = object(event.sender);
  const senderId = object(sender.sender_id);
  const message = object(event.message);
  const payload = eventType === "card.action" ? cardPayload(event) : event;
  const eventId = String(header.event_id ?? deriveExternalEventId({ provider: raw.provider, connectionId: raw.connectionId, eventType, occurredAt: raw.receivedAt, stableFields: raw.body }));
  return [unifiedEventSchema.parse({
    eventId,
    provider: raw.provider,
    connectionId: raw.connectionId,
    tenantId: raw.tenantId,
    eventType,
    occurredAt: isoTime(header.create_time, raw.receivedAt),
    externalActor: actor(senderId.open_id ?? senderId.user_id ?? object(event.operator).open_id),
    externalContext: compactContext({ chatId: message.chat_id ?? event.open_chat_id, threadId: message.thread_id, messageId: message.message_id, externalEventType: externalType }),
    payload,
    rawDigest: digestPayload(raw.rawBody),
    schemaVersion: 1,
    traceId: raw.traceId,
  })];
}

export function normalizeDingtalkEvent(raw: VerifiedRawEvent): UnifiedEvent[] {
  const headers = object(raw.body.headers);
  const dataValue = raw.body.data;
  const data = typeof dataValue === "string" ? object(JSON.parse(dataValue)) : object(dataValue ?? raw.body);
  const externalType = String(headers.topic ?? raw.body.topic ?? data.EventType ?? data.eventType ?? "unknown");
  const mapped = Object.entries(dingtalkEventTypes).find(([prefix]) => externalType.toLowerCase().includes(prefix))?.[1];
  const eventType = mapped ?? `provider.${externalType}`;
  const occurredAt = isoTime(headers.time ?? raw.body.time ?? data.createAt ?? data.createTime, raw.receivedAt);
  const eventId = String(headers.messageId ?? raw.body.messageId ?? data.eventId ?? deriveExternalEventId({ provider: raw.provider, connectionId: raw.connectionId, eventType, occurredAt, stableFields: data }));
  return [unifiedEventSchema.parse({
    eventId,
    provider: raw.provider,
    connectionId: raw.connectionId,
    tenantId: raw.tenantId,
    eventType,
    occurredAt,
    externalActor: actor(data.senderStaffId ?? data.senderId ?? data.operator),
    externalContext: compactContext({ chatId: data.conversationId ?? data.openConversationId, messageId: data.msgId, externalEventType: externalType }),
    payload: eventType === "card.action" ? cardPayload(data) : data,
    rawDigest: digestPayload(raw.rawBody),
    schemaVersion: 1,
    traceId: raw.traceId,
  })];
}

function mapWecomEvent(body: Record<string, unknown>): string {
  const msgType = String(body.MsgType ?? "").toLowerCase();
  const event = String(body.Event ?? "").toLowerCase();
  if (msgType === "text") return "message.received";
  if (event === "click" || event === "view" || event === "template_card_event") return "card.action";
  if (event === "change_contact") return String(body.ChangeType ?? "").toLowerCase().includes("party") ? "department.changed" : "user.changed";
  if (event.includes("approval")) return "approval.changed";
  return `provider.${event || msgType || "unknown"}`;
}

export function normalizeWecomEvent(raw: VerifiedRawEvent): UnifiedEvent[] {
  const body = raw.body;
  const eventType = mapWecomEvent(body);
  const occurredAt = isoTime(body.CreateTime, raw.receivedAt);
  const externalType = `${String(body.MsgType ?? "")}:${String(body.Event ?? "")}:${String(body.ChangeType ?? "")}`;
  const eventId = String(body.MsgId ?? deriveExternalEventId({ provider: raw.provider, connectionId: raw.connectionId, eventType, occurredAt, stableFields: { from: body.FromUserName, eventKey: body.EventKey, externalType } }));
  const actionValue = String(body.EventKey ?? body.TaskId ?? "");
  let actionPayload: Record<string, unknown> = {};
  try { actionPayload = object(JSON.parse(actionValue)); } catch { actionPayload = { actionId: actionValue }; }
  return [unifiedEventSchema.parse({
    eventId,
    provider: raw.provider,
    connectionId: raw.connectionId,
    tenantId: raw.tenantId,
    eventType,
    occurredAt,
    externalActor: actor(body.FromUserName ?? body.UserID),
    externalContext: compactContext({ applicationId: body.AgentID, messageId: body.MsgId, externalEventType: externalType }),
    payload: eventType === "card.action" ? cardPayload({ value: actionPayload }) : body,
    rawDigest: digestPayload(raw.rawBody),
    schemaVersion: 1,
    traceId: raw.traceId,
  })];
}
