import { createPiSandboxSupervisorServer } from "../src/modules/pi-agent/supervisor/http-server";
import { createPiSandboxSupervisorBackendFromEnv } from "../src/modules/pi-agent/supervisor/backend";
import { FilePiSandboxBindingStore } from "../src/modules/pi-agent/supervisor/store";
import { createPiSandboxRunTokenIssuerFromEnv } from "../src/modules/pi-agent/application/sandbox-token";

const host = process.env.NEXUS_PI_SANDBOX_SUPERVISOR_HOST ?? "0.0.0.0";
const port = Number(process.env.NEXUS_PI_SANDBOX_SUPERVISOR_PORT ?? "8080");
const stateDirectory = process.env.NEXUS_PI_SANDBOX_STATE_DIR ?? "/var/lib/nexus/pi-sandbox-supervisor";
const backend = createPiSandboxSupervisorBackendFromEnv();
let tokenVerifier;
try {
  tokenVerifier = createPiSandboxRunTokenIssuerFromEnv();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "not_ready", code: error instanceof Error ? error.message : "PI_SANDBOX_RUN_TOKEN_SECRET_REQUIRED" })}\n`);
}

const server = createPiSandboxSupervisorServer({
  backend,
  tokenVerifier,
  bindingStore: new FilePiSandboxBindingStore(stateDirectory),
});

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ status: "listening", host, port, backend: backend.kind })}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
