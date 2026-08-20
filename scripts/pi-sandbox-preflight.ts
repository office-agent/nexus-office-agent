import { collectPiSandboxPreflight } from "../src/modules/pi-agent/supervisor/preflight";

async function main(): Promise<void> {
  const result = await collectPiSandboxPreflight();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "ready") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: error instanceof Error ? error.message : "PI_SANDBOX_PREFLIGHT_FAILED" })}\n`);
  process.exitCode = 1;
});
