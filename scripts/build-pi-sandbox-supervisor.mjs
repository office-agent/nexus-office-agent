import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const outputDirectory = path.resolve(".pi-runtime");
await mkdir(outputDirectory, { recursive: true });
const esbuildEntry = path.resolve("node_modules/esbuild/bin/esbuild");
const executable = process.platform === "win32" ? process.execPath : esbuildEntry;
const executableArguments = process.platform === "win32" ? [esbuildEntry] : [];
const child = spawn(executable, [
  ...executableArguments,
  "scripts/pi-sandbox-supervisor.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--outfile=${path.join(outputDirectory, "pi-sandbox-supervisor.mjs")}`,
], { stdio: "inherit", cwd: process.cwd(), ...(process.platform === "win32" ? {} : { shell: false }) });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
