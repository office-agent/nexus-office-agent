import { access } from "node:fs/promises";
import { createPiRunnerRuntime } from "../src/modules/pi-agent/runner-runtime";

async function main() {
  const runtime = createPiRunnerRuntime();
  const controller = new AbortController();
  let testShutdownTimer: ReturnType<typeof setInterval> | undefined;
  const requestShutdown = () => {
    if (!controller.signal.aborted) controller.abort();
    if (testShutdownTimer) {
      clearInterval(testShutdownTimer);
      testShutdownTimer = undefined;
    }
  };
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  const testShutdownFile = process.env.NEXUS_PI_TEST_SHUTDOWN_FILE;
  if (testShutdownFile && process.env.NODE_ENV !== "production" && process.env.NEXUS_PI_TEST_RUNTIME === "cooperative") {
    testShutdownTimer = setInterval(() => {
      void access(testShutdownFile).then(requestShutdown).catch(() => undefined);
    }, 25);
  }

  try {
    await runtime.supervisor.run(controller.signal);
  } finally {
    if (testShutdownTimer) clearInterval(testShutdownTimer);
    await runtime.database.close();
  }
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: "failed", code: error instanceof Error ? error.message : "PI_RUNNER_FAILED" }) + "\n");
  process.exitCode = 1;
});
