// Requirements: IR-004, SR-004
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWecomRuntimeConfiguration,
  WECOM_ENV_FILE,
} from "@/src/platform/config/wecom-environment";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function dedicatedEnvironment(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "nexus-wecom-env-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, WECOM_ENV_FILE), contents, "utf8");
  return directory;
}

describe("dedicated WeCom environment", () => {
  it("uses the dedicated file instead of same-named values from the shared environment", () => {
    const cwd = dedicatedEnvironment([
      "WECOM_CORP_ID=dedicated-corp",
      "WECOM_APP_SECRET=dedicated-secret",
      "WECOM_AGENT_ID=10001",
    ].join("\n"));

    const result = loadWecomRuntimeConfiguration({
      WECOM_CORP_ID: "shared-corp",
      WECOM_APP_SECRET: "shared-secret",
      WECOM_AGENT_ID: "9999999",
    }, { cwd, loadDedicatedFile: true });

    expect(result).toEqual({
      corpId: "dedicated-corp",
      appSecret: "dedicated-secret",
      agentId: "10001",
      configured: true,
      source: "dedicated-environment",
    });
  });

  it("does not fall back to a shared Secret when the dedicated file is incomplete", () => {
    const cwd = dedicatedEnvironment([
      "WECOM_CORP_ID=dedicated-corp",
      "WECOM_APP_SECRET=",
      "WECOM_AGENT_ID=10001",
    ].join("\n"));

    const result = loadWecomRuntimeConfiguration({ WECOM_APP_SECRET: "must-not-be-used" }, {
      cwd,
      loadDedicatedFile: true,
    });

    expect(result.configured).toBe(false);
    expect(result.appSecret).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("must-not-be-used");
  });
});
