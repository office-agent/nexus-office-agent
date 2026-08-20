// Requirements: IR-001, IR-004, SR-001, SR-004, AC-005, AC-012
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry, assertToolPolicy } from "@/src/modules/agent/domain/tool";
import { registerWecomApplicationMessageTools } from "@/src/modules/integration/application/wecom-agent-tools";
import {
  type WecomApplicationMessageGateway,
  WecomApplicationMessageService,
} from "@/src/modules/integration/application/wecom-application-message";
import { DEMO_CONNECTION_IDS, InMemoryAcceptanceRepository } from "@/src/modules/integration/infrastructure/acceptance-repository";
import { RuntimeWecomApplicationMessageGateway } from "@/src/modules/integration/infrastructure/wecom-application-message-gateway";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function activeRepository() {
  const repository = new InMemoryAcceptanceRepository();
  repository.connections.get(DEMO_CONNECTION_IDS.wecom)!.status = "active";
  return repository;
}

describe("WeCom application messaging", () => {
  it("keeps direct sends behind web-only R3 confirmation", () => {
    const registry = new ToolRegistry();
    const gateway: WecomApplicationMessageGateway = { async resolveAndSend() { throw new Error("NOT_CALLED"); } };
    registerWecomApplicationMessageTools(registry, new WecomApplicationMessageService(activeRepository(), gateway));
    const tool = registry.get("wecom.send_application_message");
    const context = createDevelopmentRequestContext();

    expect(assertToolPolicy(context, tool)).toEqual({ requiresConfirmation: true });
    expect(tool.preview({ connectionId: DEMO_CONNECTION_IDS.wecom, recipientName: "王渊芃", text: "接口测试" }))
      .toContain("王渊芃");
    expect(() => assertToolPolicy({ ...context, channel: "wecom" }, tool)).toThrow("TOOL_CHANNEL_DENIED");
    expect(() => assertToolPolicy({ ...context, permissions: ["wecom_app:read"] }, tool)).toThrow("TOOL_PERMISSION_DENIED");
  });

  it("requires an active tenant-bound connection and never accepts an empty idempotency key", async () => {
    const repository = new InMemoryAcceptanceRepository();
    const gateway: WecomApplicationMessageGateway = { async resolveAndSend() { throw new Error("NOT_CALLED"); } };
    const service = new WecomApplicationMessageService(repository, gateway);
    const context = createDevelopmentRequestContext();

    await expect(service.send(context, DEMO_CONNECTION_IDS.wecom, { recipientName: "王渊芃", text: "测试" }, "idempotent-1"))
      .rejects.toThrow("WECOM_CONNECTION_NOT_ACTIVE");
    repository.connections.get(DEMO_CONNECTION_IDS.wecom)!.status = "active";
    await expect(service.send(context, DEMO_CONNECTION_IDS.wecom, { recipientName: "王渊芃", text: "测试" }, ""))
      .rejects.toThrow("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("resolves an exact member name server-side and sends through message/send without returning UserID or credentials", async () => {
    vi.stubEnv("WECOM_CORP_ID", "fixture-corp");
    vi.stubEnv("WECOM_APP_SECRET", "fixture-secret");
    vi.stubEnv("WECOM_AGENT_ID", "10001");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/cgi-bin/gettoken")) return Response.json({ errcode: 0, access_token: "fixture-token", expires_in: 7200 });
      if (String(url).includes("/cgi-bin/user/simplelist")) return Response.json({
        errcode: 0,
        userlist: [
          { userid: "other-user", name: "其他成员" },
          { userid: "wang-secret-userid", name: "王渊芃" },
        ],
      });
      return Response.json({ errcode: 0, errmsg: "ok", msgid: "wecom-message-42" });
    }));

    const service = new WecomApplicationMessageService(activeRepository(), new RuntimeWecomApplicationMessageGateway());
    const result = await service.send(
      createDevelopmentRequestContext(),
      DEMO_CONNECTION_IDS.wecom,
      { recipientName: " 王渊芃 ", text: "企业微信 AI 接口测试成功。" },
      "agent-run-42:tool-1",
    );

    expect(result).toMatchObject({ status: "accepted", recipientName: "王渊芃", secretExposed: false });
    expect(result.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("wang-secret-userid");
    expect(JSON.stringify(result)).not.toContain("fixture-token");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    const sendRequest = requests.find(({ url }) => url.includes("/cgi-bin/message/send"))!;
    expect(sendRequest.url).toContain("access_token=fixture-token");
    expect(JSON.parse(String(sendRequest.init?.body))).toMatchObject({
      touser: "wang-secret-userid",
      agentid: "10001",
      msgtype: "text",
      text: { content: "企业微信 AI 接口测试成功。" },
    });
    expect(requests.filter(({ url }) => url.includes("/cgi-bin/gettoken"))).toHaveLength(1);
  });

  it("fails closed on ambiguous names before sending", async () => {
    vi.stubEnv("WECOM_CORP_ID", "fixture-corp");
    vi.stubEnv("WECOM_APP_SECRET", "fixture-secret");
    vi.stubEnv("WECOM_AGENT_ID", "10001");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      if (String(url).includes("/cgi-bin/gettoken")) return Response.json({ access_token: "fixture-token", expires_in: 7200 });
      return Response.json({ errcode: 0, userlist: [
        { userid: "wang-1", name: "王渊芃" },
        { userid: "wang-2", name: "王渊芃" },
      ] });
    }));

    const service = new WecomApplicationMessageService(activeRepository(), new RuntimeWecomApplicationMessageGateway());
    await expect(service.send(createDevelopmentRequestContext(), DEMO_CONNECTION_IDS.wecom, { recipientName: "王渊芃", text: "测试" }, "ambiguous-1"))
      .rejects.toThrow("WECOM_RECIPIENT_AMBIGUOUS");
    expect(requests.some((url) => url.includes("/cgi-bin/message/send"))).toBe(false);
  });

  it("treats errcode zero with invaliduser as a failed delivery", async () => {
    vi.stubEnv("WECOM_CORP_ID", "fixture-corp");
    vi.stubEnv("WECOM_APP_SECRET", "fixture-secret");
    vi.stubEnv("WECOM_AGENT_ID", "10001");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/cgi-bin/gettoken")) return Response.json({ access_token: "fixture-token", expires_in: 7200 });
      if (String(url).includes("/cgi-bin/user/simplelist")) return Response.json({ errcode: 0, userlist: [{ userid: "stale-user", name: "王渊芃" }] });
      return Response.json({ errcode: 0, errmsg: "ok", invaliduser: "stale-user", msgid: "ignored-message" });
    }));

    const service = new WecomApplicationMessageService(activeRepository(), new RuntimeWecomApplicationMessageGateway());
    await expect(service.send(createDevelopmentRequestContext(), DEMO_CONNECTION_IDS.wecom, { recipientName: "王渊芃", text: "测试" }, "invalid-1"))
      .rejects.toThrow("WECOM_INVALIDUSER");
  });
});
