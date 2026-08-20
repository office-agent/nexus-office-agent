import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const outputDirectory = path.resolve(".pi-runtime");
await mkdir(outputDirectory, { recursive: true });

const child = spawn(process.execPath, [
  path.resolve("node_modules/esbuild/bin/esbuild"),
  "scripts/pi-runner.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--outfile=${path.join(outputDirectory, "pi-runner.mjs")}`,
  "--external:@earendil-works/pi-ai",
  "--external:@earendil-works/pi-coding-agent",
], { stdio: "inherit", cwd: process.cwd() });

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
