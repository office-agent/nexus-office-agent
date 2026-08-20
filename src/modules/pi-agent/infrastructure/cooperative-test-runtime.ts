import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeAdapter, PiRuntimeInput } from "@/src/modules/pi-agent/infrastructure/runtime-adapter";

type TestEvent = { type: string; [key: string]: unknown };

function positiveMilliseconds(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function emit(listeners: Set<(event: TestEvent) => void>, event: TestEvent): void {
  for (const listener of listeners) listener(event);
}

/**
 * Deterministic, abortable Runtime used only by the opt-in real Runner
 * process harness. It emits the same event classes the Runner persists, but
 * never represents a production model or tool implementation.
 */
export function createCooperativePiRuntime(input: PiRuntimeInput): Promise<PiRuntimeAdapter> {
  const listeners = new Set<(event: TestEvent) => void>();
  let aborted = false;
  let rejectPrompt: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const prompt = async (): Promise<void> => {
    emit(listeners, { type: "agent_start" });
    await new Promise<void>((resolve, reject) => {
      rejectPrompt = reject;
      if (aborted) {
        reject(new Error("PI_RUN_ABORTED"));
        return;
      }
      timer = setTimeout(resolve, positiveMilliseconds(process.env.NEXUS_PI_TEST_RUNTIME_AUTO_COMPLETE_MS, 25));
    });
    rejectPrompt = undefined;
    timer = undefined;
    if (aborted) throw new Error("PI_RUN_ABORTED");
    emit(listeners, { type: "tool_execution_start", toolName: "test.read", toolCallId: "test-tool-call" });
    emit(listeners, { type: "tool_execution_end", toolName: "test.read", toolCallId: "test-tool-call", result: { ok: true } });
    emit(listeners, { type: "agent_end" });
  };

  const abort = async (): Promise<void> => {
    aborted = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    rejectPrompt?.(new Error("PI_RUN_ABORTED"));
    rejectPrompt = undefined;
  };

  const session = {
    prompt,
    abort,
  } as unknown as AgentSession;

  return Promise.resolve({
    session,
    sandbox: input.sandbox,
    model: {} as never,
    subscribe(listener: (event: never) => void) {
      const typed = listener as unknown as (event: TestEvent) => void;
      listeners.add(typed);
      return () => listeners.delete(typed);
    },
    async dispose() {
      await abort();
      listeners.clear();
    },
  });
}
