export type ModelToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ModelToolCall[];
};

export type ModelToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ModelRequest = {
  tenantId: string;
  traceId: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  toolChoice?: "auto" | "none";
  responseFormat?: "text" | "json";
  dataClassification: DataClassification;
};

export type ModelResponse = {
  content: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolCalls?: ModelToolCall[];
};

export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class FakeModelGateway implements ModelGateway {
  constructor(private readonly answer = "这是受控测试模型响应。") {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.dataClassification === "restricted") throw new Error("MODEL_POLICY_DENIED");
    const content = request.responseFormat === "json" && !this.answer.trim().startsWith("{")
      ? JSON.stringify({ answer: this.answer })
      : this.answer;
    return {
      content,
      provider: "fake",
      model: "deterministic-test-model",
      inputTokens: request.messages.reduce((sum, message) => sum + message.content.length, 0),
      outputTokens: content.length,
      latencyMs: 0,
    };
  }
}

export class OpenAICompatibleModelGateway implements ModelGateway {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.dataClassification === "restricted") throw new Error("MODEL_POLICY_DENIED");
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            tool_call_id: message.toolCallId,
            name: message.name,
            tool_calls: message.toolCalls?.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
          })),
          tools: request.tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
          tool_choice: request.tools?.length ? request.toolChoice ?? "auto" : undefined,
          response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined,
        }),
      });
      if (!response.ok) throw new Error(`MODEL_PROVIDER_ERROR:${response.status}`);
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const message = payload.choices?.[0]?.message;
      const content = message?.content?.trim() ?? "";
      const toolCalls = (message?.tool_calls ?? []).map((call) => {
        if (!call.id || !call.function?.name || typeof call.function.arguments !== "string") throw new Error("MODEL_TOOL_CALL_INVALID");
        let parsed: unknown;
        try { parsed = JSON.parse(call.function.arguments); } catch { throw new Error("MODEL_TOOL_ARGUMENTS_INVALID"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MODEL_TOOL_ARGUMENTS_INVALID");
        return { id: call.id, name: call.function.name, arguments: parsed as Record<string, unknown> };
      });
      if (!content && toolCalls.length === 0) throw new Error("MODEL_RESPONSE_INVALID");
      return {
        content, provider: "openai-compatible", model: this.model,
        inputTokens: payload.usage?.prompt_tokens ?? 0, outputTokens: payload.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - startedAt,
        toolCalls,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("MODEL_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class UnavailableModelGateway implements ModelGateway {
  async complete(): Promise<ModelResponse> { throw new Error("MODEL_UNAVAILABLE"); }
}
import type { DataClassification } from "@/src/platform/security/data-classification";
