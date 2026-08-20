// Requirements: IR-001, IR-004, AR-012, SR-004, AC-005
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry, assertToolPolicy } from "@/src/modules/agent/domain/tool";
import {
  type WecomAppControlGateway,
  type WecomApplicationPatch,
  type WecomApplicationSnapshot,
  WecomAccessControlService,
} from "@/src/modules/integration/application/wecom-access-control";
import { registerWecomAccessControlTools } from "@/src/modules/integration/application/wecom-agent-tools";
import { DEMO_CONNECTION_IDS, InMemoryAcceptanceRepository } from "@/src/modules/integration/infrastructure/acceptance-repository";
import { RuntimeWecomAppControlGateway } from "@/src/modules/integration/infrastructure/wecom-app-control-gateway";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

const snapshot: WecomApplicationSnapshot = {
  agentId: "10001",
  name: "Nexus AI 办公助手",
  description: "企业办公入口",
  visibleUserCount: 1,
  visibleDepartmentIds: [1, 2],
  visibleTagIds: [3],
  closed: false,
  redirectDomain: "office.example.com",
  homeUrl: "https://office.example.com",
  reportsLocation: false,
  reportsEnterEvent: true,
};

class FakeGateway implements WecomAppControlGateway {
  readonly updates: Array<{ connectionId: string; patch: WecomApplicationPatch }> = [];
  constructor(private readonly value: WecomApplicationSnapshot = snapshot) {}
  async getApplication() { return structuredClone(this.value); }
  async updateApplication(connectionId: string, patch: WecomApplicationPatch) {
    this.updates.push({ connectionId, patch: structuredClone(patch) });
    return { ...this.value, ...patch };
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("WeCom access control", () => {
  it("reports the real control boundaries without exposing any credential", async () => {
    const repository = new InMemoryAcceptanceRepository();
    repository.connections.get(DEMO_CONNECTION_IDS.wecom)!.status = "active";
    const result = await new WecomAccessControlService(repository, new FakeGateway(), () => new Date("2026-08-14T00:00:00.000Z"))
      .inspect(createDevelopmentRequestContext(), DEMO_CONNECTION_IDS.wecom);

    expect(result.liveCheck).toEqual({ status: "passed" });
    expect(result.liveApplication).toMatchObject({ agentId: "10001", visibleUserCount: 1, visibleDepartmentIds: [1, 2] });
    expect(JSON.stringify(result)).not.toContain("zhangsan");
    expect(result.boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "application.visible_scope", controlMode: "admin_console", aiExecution: "disabled" }),
      expect.objectContaining({ capability: "directory.write", controlMode: "contact_sync_credential", aiExecution: "disabled" }),
      expect.objectContaining({ capability: "directory.sensitive_fields", controlMode: "user_oauth", aiExecution: "disabled" }),
    ]));
    expect(result.secretExposed).toBe(false);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("access_token");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("keeps app changes behind R3 confirmation and a web-only admin permission", () => {
    const repository = new InMemoryAcceptanceRepository();
    const registry = new ToolRegistry();
    registerWecomAccessControlTools(registry, new WecomAccessControlService(repository, new FakeGateway()));
    const tool = registry.get("wecom.update_application");
    const context = createDevelopmentRequestContext();

    expect(assertToolPolicy(context, tool)).toEqual({ requiresConfirmation: true });
    expect(tool.preview({ connectionId: DEMO_CONNECTION_IDS.wecom, reportsLocation: true })).toContain("隐私影响");
    expect(() => assertToolPolicy({ ...context, channel: "wecom" }, tool)).toThrow("TOOL_CHANNEL_DENIED");
    expect(() => assertToolPolicy({ ...context, permissions: ["wecom_app:read"] }, tool)).toThrow("TOOL_PERMISSION_DENIED");
  });

  it("allows only trusted HTTPS destinations and refuses inactive connections", async () => {
    vi.stubEnv("PUBLIC_APP_ORIGIN", "https://office.example.com");
    const repository = new InMemoryAcceptanceRepository();
    const gateway = new FakeGateway();
    const service = new WecomAccessControlService(repository, gateway);
    const context = createDevelopmentRequestContext();

    await expect(service.updateApplication(context, DEMO_CONNECTION_IDS.wecom, { name: "新名称" }))
      .rejects.toThrow("WECOM_CONNECTION_NOT_ACTIVE");
    repository.connections.get(DEMO_CONNECTION_IDS.wecom)!.status = "active";
    await expect(service.updateApplication(context, DEMO_CONNECTION_IDS.wecom, { homeUrl: "https://evil.example/app" }))
      .rejects.toThrow("WECOM_HOME_URL_NOT_ALLOWED");

    const result = await service.updateApplication(context, DEMO_CONNECTION_IDS.wecom, {
      redirectDomain: "office.example.com",
      homeUrl: "https://office.example.com/wecom",
    });
    expect(result.appliedFields).toEqual(["redirectDomain", "homeUrl"]);
    expect(gateway.updates).toEqual([{ connectionId: DEMO_CONNECTION_IDS.wecom, patch: {
      redirectDomain: "office.example.com",
      homeUrl: "https://office.example.com/wecom",
    } }]);
  });

  it("binds API calls to the server-side AgentId and verifies the update with a fresh read", async () => {
    vi.stubEnv("WECOM_CORP_ID", "fixture-corp");
    vi.stubEnv("WECOM_APP_SECRET", "fixture-secret");
    vi.stubEnv("WECOM_AGENT_ID", "10001");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/cgi-bin/gettoken")) return Response.json({ access_token: "fixture-token", expires_in: 7200 });
      if (String(url).includes("/cgi-bin/agent/set")) return Response.json({ errcode: 0, errmsg: "ok" });
      return Response.json({
        errcode: 0,
        agentid: 10001,
        name: "Nexus AI",
        description: "updated",
        allow_userinfos: { user: [{ userid: "zhangsan" }] },
        allow_partys: { partyid: [1] },
        allow_tags: { tagid: [] },
        close: 0,
        redirect_domain: "office.example.com",
        home_url: "https://office.example.com/wecom",
        report_location_flag: 0,
        isreportenter: 1,
      });
    }));

    const result = await new RuntimeWecomAppControlGateway().updateApplication(DEMO_CONNECTION_IDS.wecom, {
      description: "updated",
      reportsEnterEvent: true,
    });

    expect(result).toMatchObject({ agentId: "10001", description: "updated", reportsEnterEvent: true });
    const setRequest = requests.find(({ url }) => url.includes("/cgi-bin/agent/set"))!;
    expect(JSON.parse(String(setRequest.init?.body))).toEqual({ agentid: 10001, description: "updated", isreportenter: 1 });
    expect(requests.some(({ url }) => url.includes("/cgi-bin/agent/get?agentid=10001") && url.includes("access_token=fixture-token"))).toBe(true);
    expect(requests.filter(({ url }) => url.includes("/cgi-bin/gettoken"))).toHaveLength(1);
  });
});
