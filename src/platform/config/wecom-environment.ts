import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export const WECOM_ENV_FILE = ".env.wecom.local";

type WecomEnvironmentOptions = {
  cwd?: string;
  loadDedicatedFile?: boolean;
};

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type WecomRuntimeConfiguration = {
  corpId?: string;
  appSecret?: string;
  agentId?: string;
  configured: boolean;
  source: "environment" | "dedicated-environment" | "unconfigured";
};

export function loadWecomRuntimeConfiguration(
  environment: RuntimeEnvironment = process.env,
  options: WecomEnvironmentOptions = {},
): WecomRuntimeConfiguration {
  const loadDedicatedFile = options.loadDedicatedFile
    ?? (environment === process.env && environment.NODE_ENV !== "test");
  let values: RuntimeEnvironment = environment;
  let dedicatedFileLoaded = false;

  if (loadDedicatedFile) {
    const filePath = resolve(options.cwd ?? process.cwd(), WECOM_ENV_FILE);
    if (existsSync(filePath)) {
      try {
        values = parseEnv(readFileSync(filePath, "utf8"));
        dedicatedFileLoaded = true;
      } catch {
        throw new Error("WECOM_ENV_FILE_INVALID");
      }
    }
  }

  const corpId = values.WECOM_CORP_ID?.trim() || undefined;
  const appSecret = values.WECOM_APP_SECRET?.trim() || undefined;
  const agentId = values.WECOM_AGENT_ID?.trim() || undefined;
  const configured = Boolean(corpId && appSecret && agentId);
  return {
    corpId,
    appSecret,
    agentId,
    configured,
    source: configured ? (dedicatedFileLoaded ? "dedicated-environment" : "environment") : "unconfigured",
  };
}

export function requireWecomCredential(): Required<Pick<WecomRuntimeConfiguration, "corpId" | "appSecret" | "agentId">> {
  const configuration = loadWecomRuntimeConfiguration();
  if (!configuration.configured) throw new Error("WECOM_CREDENTIAL_UNCONFIGURED");
  return {
    corpId: configuration.corpId!,
    appSecret: configuration.appSecret!,
    agentId: configuration.agentId!,
  };
}

export function requireWecomAgentId(): string {
  const agentId = loadWecomRuntimeConfiguration().agentId;
  if (!agentId || !/^\d+$/.test(agentId)) throw new Error("WECOM_AGENT_ID_UNCONFIGURED");
  return agentId;
}
