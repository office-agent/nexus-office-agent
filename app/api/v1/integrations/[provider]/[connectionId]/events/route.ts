import { NextResponse } from "next/server";
import { z } from "zod";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { WebhookIngressService } from "@/src/modules/integration/application/webhook-ingress";
import { PostgresConnectionRepository } from "@/src/modules/integration/infrastructure/connection-repository";
import { createConnectorSecretResolver } from "@/src/modules/integration/infrastructure/secret-resolver";
import { ConnectorSecurityError } from "@/src/modules/integration/security/callback-crypto";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

const paramsSchema = z.object({ provider: z.enum(["feishu", "dingtalk", "wecom"]), connectionId: z.uuid() });
const queryKeys = ["tenant_id", "timestamp", "nonce", "signature", "msg_signature", "echostr"] as const;

function publicError(error: unknown): { status: number; code: string } {
  if (error instanceof ConnectorSecurityError || (error instanceof Error && error.message === "VERIFICATION_TOKEN_INVALID")) return { status: 401, code: "WEBHOOK_VERIFICATION_FAILED" };
  if (error instanceof Error && error.message === "WEBHOOK_CONNECTION_NOT_FOUND") return { status: 404, code: error.message };
  if (error instanceof Error && error.message.includes("UNCONFIGURED")) return { status: 503, code: "CONNECTOR_RUNTIME_UNCONFIGURED" };
  return { status: 400, code: "WEBHOOK_REJECTED" };
}

async function handle(request: Request, context: { params: Promise<{ provider: string; connectionId: string }> }) {
  const parsed = paramsSchema.safeParse(await context.params);
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant_id");
  if (!parsed.success || !tenantId || !z.uuid().safeParse(tenantId).success) return NextResponse.json({ error: { code: "WEBHOOK_PATH_INVALID" } }, { status: 400 });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return NextResponse.json({ error: { code: "CONNECTOR_RUNTIME_UNCONFIGURED" } }, { status: 503 });
  const query = Object.fromEntries(queryKeys.map((key) => [key, url.searchParams.get(key) ?? undefined]));
  const headers = Object.fromEntries(["x-lark-request-timestamp", "x-lark-request-nonce", "x-lark-signature"].map((key) => [key, request.headers.get(key) ?? undefined]));
  const rawBody = request.method === "GET" ? "" : await request.text();
  const database = createPostgresDatabase(databaseUrl);
  try {
    const service = new WebhookIngressService(new PostgresConnectionRepository(database), createConnectorSecretResolver(), new PostgresEventStore(database));
    const result = await service.receive({ tenantId, connectionId: parsed.data.connectionId, provider: parsed.data.provider, headers, query, rawBody, receivedAt: new Date().toISOString(), traceId: request.headers.get("x-request-id") ?? crypto.randomUUID() });
    if (result.challenge?.provider === "wecom") return new NextResponse(result.challenge.value, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    if (result.challenge?.provider === "feishu") return NextResponse.json({ challenge: result.challenge.value }, { status: 200 });
    if (result.acknowledgment) return new NextResponse(result.acknowledgment.body, { status: 200, headers: { "content-type": result.acknowledgment.contentType, "x-nexus-events-accepted": String(result.accepted), "x-nexus-events-duplicate": String(result.duplicates) } });
    return NextResponse.json({ accepted: true, events: result.accepted, duplicates: result.duplicates }, { status: 202 });
  } catch (error) {
    const response = publicError(error);
    return NextResponse.json({ error: { code: response.code } }, { status: response.status });
  } finally {
    await database.close();
  }
}

export const POST = handle;
export const GET = handle;
