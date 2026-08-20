import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

// `next dev` and `next build` load .env.* automatically, but a standalone
// server is a plain Node process. Load the same runtime files for local
// `npm run start`; container deployments still inject their environment and
// do not copy ignored .env files into the image.
loadEnvConfig(process.cwd(), process.env.NODE_ENV === "development");

const standaloneServer = fileURLToPath(new URL("../.next/standalone/server.js", import.meta.url));
if (!existsSync(standaloneServer)) {
  throw new Error("Standalone server not found. Run npm run build before npm run start.");
}

// Next.js standalone output intentionally does not include these assets. Keep
// the self-hosted runtime complete so CSS, client chunks, and public icons do
// not become 404s after `next build`.
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const standaloneRoot = resolve(projectRoot, ".next", "standalone");
const staticSource = resolve(projectRoot, ".next", "static");
const staticTarget = resolve(standaloneRoot, ".next", "static");
if (existsSync(staticSource)) {
  mkdirSync(resolve(standaloneRoot, ".next"), { recursive: true });
  cpSync(staticSource, staticTarget, { recursive: true, force: true });
}
const publicSource = resolve(projectRoot, "public");
const publicTarget = resolve(standaloneRoot, "public");
if (existsSync(publicSource)) cpSync(publicSource, publicTarget, { recursive: true, force: true });

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if ((args[index] === "-p" || args[index] === "--port") && args[index + 1]) {
    process.env.PORT = args[index + 1];
    index += 1;
  }
  if ((args[index] === "-H" || args[index] === "--hostname") && args[index + 1]) {
    process.env.HOSTNAME = args[index + 1];
    index += 1;
  }
}

// Node's ESM loader requires a file:// URL for Windows absolute paths.
await import(pathToFileURL(standaloneServer).href);
