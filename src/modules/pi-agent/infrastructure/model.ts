import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export type PiModelBinding = {
  runtime: ModelRuntime;
  model: Model<"openai-completions">;
  route: string;
};

/**
 * Resolve the existing platform model gateway without copying credentials into the session.
 * The Pi provider receives an environment-variable reference; the secret remains process-local.
 */
export async function resolvePiModel(): Promise<PiModelBinding | undefined> {
  if (process.env.NEXUS_MODEL_MODE === "disabled" || process.env.NEXUS_PI_MODEL_MODE === "disabled") return undefined;
  const keyEnv = process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : process.env.LLM_API_KEY ? "LLM_API_KEY" : undefined;
  const baseUrl = process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL;
  const modelId = process.env.OPENAI_MODEL || process.env.LLM_MODEL;
  if (!keyEnv || !baseUrl || !modelId) return undefined;

  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("nexus-model-gateway", {
    name: "Nexus Model Gateway",
    api: "openai-completions",
    baseUrl,
    apiKey: `$${keyEnv}`,
    authHeader: true,
    models: [{
      id: modelId,
      name: modelId,
      api: "openai-completions",
      baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Number(process.env.NEXUS_PI_CONTEXT_WINDOW || 128_000),
      maxTokens: Number(process.env.NEXUS_PI_MAX_OUTPUT_TOKENS || 16_384),
      compat: { supportsUsageInStreaming: true },
    }],
  });
  const model = runtime.getModel("nexus-model-gateway", modelId);
  if (!model) throw new Error("PI_MODEL_ROUTE_NOT_FOUND");
  return { runtime, model: model as Model<"openai-completions">, route: `nexus-model-gateway/${modelId}` };
}
