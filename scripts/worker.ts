import { createDurableWorkerRuntime } from "../src/platform/workers/runtime";

async function main() {
  const runtime = createDurableWorkerRuntime();
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());

  try {
    await runtime.supervisor.run(controller.signal);
  } finally {
    await runtime.database.close();
  }
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: "failed", code: error instanceof Error ? error.message : "WORKER_FAILED" }) + "\n");
  process.exitCode = 1;
});
