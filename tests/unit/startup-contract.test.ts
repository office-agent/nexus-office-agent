// Requirements: PR-001, AR-001, AC-001
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production startup contract", () => {
  it("uses the standalone server launcher when standalone output is enabled", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts?: { start?: string } };
    expect(packageJson.scripts?.start).toBe("node scripts/start-standalone.mjs");
  });

  it("loads the standalone server through a Windows-safe file URL", () => {
    const launcher = readFileSync(new URL("../../scripts/start-standalone.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("pathToFileURL(standaloneServer).href");
  });

  it("loads the same env files as the Next.js runtime", () => {
    const launcher = readFileSync(new URL("../../scripts/start-standalone.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("loadEnvConfig(process.cwd()");
  });

  it("synchronizes standalone static and public assets before boot", () => {
    const launcher = readFileSync(new URL("../../scripts/start-standalone.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("cpSync(staticSource, staticTarget");
    expect(launcher).toContain("cpSync(publicSource, publicTarget");
  });

  it("exposes an explicit LAN-only launcher", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts?: { [key: string]: string } };
    const launcher = readFileSync(new URL("../../scripts/start-lan.mjs", import.meta.url), "utf8");
    expect(packageJson.scripts?.["start:lan"]).toBe("node scripts/start-lan.mjs");
    expect(launcher).toContain('NEXUS_DEPLOYMENT_MODE = "lan"');
    expect(launcher).toContain('HOSTNAME ??= "0.0.0.0"');
  });
});
