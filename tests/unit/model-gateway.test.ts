// Requirements: PR-005, PR-006, MR-005, MR-030, SR-003, SR-004, SR-006, AC-004, AC-006, AC-007
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelGateway, type ModelRequest } from "@/src/modules/agent/domain/model-gateway";
import type { DataClassification } from "@/src/platform/security/data-classification";

function request(dataClassification: DataClassification = "internal", toolCalls = false): ModelRequest {
  return {
    tenantId: "tenant",
    traceId: "trace",
    messages: [{ role: "user", content: "分析当前风险" }],
    dataClassification,
    responseFormat: toolCalls ? undefined : "json",
  };
}

function okResponse(overrides: Record<string, unknown> = {}) {
  return { ok: true, status: 200, json: async () => overrides };
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible model gateway failure classification", () => {
  it("maps a generic provider network failure to MODEL_PROVIDER_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request())).rejects.toThrow("MODEL_PROVIDER_UNAVAILABLE");
  });

  it("maps an HTTP provider error to MODEL_PROVIDER_ERROR with its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request())).rejects.toThrow("MODEL_PROVIDER_ERROR:503");
  });

  it("maps an aborted request to MODEL_TIMEOUT", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(abort)));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request())).rejects.toThrow("MODEL_TIMEOUT");
  });

  it("refuses restricted classification before any network call", async () => {
    const fetchMock = vi.fn(async () => okResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request("restricted"))).rejects.toThrow("MODEL_POLICY_DENIED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on malformed tool-call arguments and keeps MODEL_ codes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({
      choices: [{ message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "work.create_task_template", arguments: "{broken" } }] } }],
    })));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request("internal", true))).rejects.toThrow("MODEL_TOOL_ARGUMENTS_INVALID");
  });

  it("parses a valid chat completion response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({
      choices: [{ message: { content: "{\"answer\":\"当前无高风险。\"}" } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    })));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    const response = await gateway.complete(request());
    expect(response.provider).toBe("openai-compatible");
    expect(response.content).toContain("当前无高风险");
    expect(response.inputTokens).toBe(12);
    expect(response.outputTokens).toBe(4);
  });
});
