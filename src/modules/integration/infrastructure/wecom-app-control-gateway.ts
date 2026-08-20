import type {
  WecomAppControlGateway,
  WecomApplicationPatch,
  WecomApplicationSnapshot,
} from "@/src/modules/integration/application/wecom-access-control";
import { AuthenticatedConnectorTransport } from "@/src/modules/integration/infrastructure/authenticated-transport";
import type { ConnectorTransport } from "@/src/modules/integration/infrastructure/platform-connector";
import {
  AccessTokenBroker,
  EnvironmentOutgoingCredentialSource,
  FetchRawHttpClient,
} from "@/src/modules/integration/infrastructure/token-broker";
import { requireWecomAgentId } from "@/src/platform/config/wecom-environment";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function numberArray(value: unknown): number[] {
  return asArray(value).map(Number).filter(Number.isFinite);
}

function assertWecomSuccess(status: number, body: Record<string, unknown>): void {
  const errcode = Number(body.errcode ?? 0);
  if (status < 200 || status >= 300) throw new Error(`WECOM_HTTP_ERROR:${status}`);
  if (errcode !== 0) throw new Error(`WECOM_API_ERROR:${errcode}`);
}

function mapApplication(body: Record<string, unknown>): WecomApplicationSnapshot {
  const users = asArray(asRecord(body.allow_userinfos).user)
    .map((item) => stringValue(asRecord(item).userid))
    .filter(Boolean);
  return {
    agentId: stringValue(body.agentid),
    name: stringValue(body.name),
    description: stringValue(body.description),
    squareLogoUrl: stringValue(body.square_logo_url) || undefined,
    visibleUserCount: users.length,
    visibleDepartmentIds: numberArray(asRecord(body.allow_partys).partyid),
    visibleTagIds: numberArray(asRecord(body.allow_tags).tagid),
    closed: Number(body.close ?? 0) === 1,
    redirectDomain: stringValue(body.redirect_domain) || undefined,
    homeUrl: stringValue(body.home_url) || undefined,
    reportsLocation: Number(body.report_location_flag ?? 0) === 1,
    reportsEnterEvent: Number(body.isreportenter ?? 0) === 1,
  };
}

function requestBody(agentId: string, patch: WecomApplicationPatch): Record<string, unknown> {
  return {
    agentid: Number(agentId),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.redirectDomain !== undefined ? { redirect_domain: patch.redirectDomain } : {}),
    ...(patch.homeUrl !== undefined ? { home_url: patch.homeUrl } : {}),
    ...(patch.reportsLocation !== undefined ? { report_location_flag: patch.reportsLocation ? 1 : 0 } : {}),
    ...(patch.reportsEnterEvent !== undefined ? { isreportenter: patch.reportsEnterEvent ? 1 : 0 } : {}),
  };
}

export class RuntimeWecomAppControlGateway implements WecomAppControlGateway {
  private readonly http = new FetchRawHttpClient();
  private readonly tokens = new AccessTokenBroker(new EnvironmentOutgoingCredentialSource(), this.http);

  private agentId(): string {
    return requireWecomAgentId();
  }

  private transport(connectionId: string): ConnectorTransport {
    return new AuthenticatedConnectorTransport("wecom", connectionId, this.tokens, this.http);
  }

  async getApplication(connectionId: string): Promise<WecomApplicationSnapshot> {
    const response = await this.transport(connectionId).request({
      method: "GET",
      path: `/cgi-bin/agent/get?agentid=${encodeURIComponent(this.agentId())}`,
    });
    assertWecomSuccess(response.status, response.body);
    return mapApplication(response.body);
  }

  async updateApplication(connectionId: string, patch: WecomApplicationPatch): Promise<WecomApplicationSnapshot> {
    const response = await this.transport(connectionId).request({
      method: "POST",
      path: "/cgi-bin/agent/set",
      body: requestBody(this.agentId(), patch),
    });
    assertWecomSuccess(response.status, response.body);
    return this.getApplication(connectionId);
  }
}
