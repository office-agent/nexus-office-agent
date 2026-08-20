export type ClientType = "web_pwa" | "desktop_pwa" | "mobile_pwa";
export type DeviceTrust = "unmanaged" | "managed" | "attested";
export type DeviceStatus = "pending" | "active" | "revoked";

export type ClientDevice = {
  id: string;
  tenantId: string;
  userId: string;
  installationId: string;
  displayName: string;
  clientType: ClientType;
  platform: string;
  appVersion: string;
  trustLevel: DeviceTrust;
  status: DeviceStatus;
  pushEnabled: boolean;
  lastSeenAt: string;
  registeredAt: string;
  revokedAt?: string;
  version: number;
};

export type EncryptedPushSubscription = {
  id: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  endpointDigest: string;
  encryptedPayload: string;
  initializationVector: string;
  authenticationTag: string;
  keyRef: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt?: string;
  version: number;
};

export type ClientPolicy = {
  minimumVersion: string;
  managedDeviceRequired: boolean;
  offlineDrafts: "disabled" | "internal";
  pushEnabled: boolean;
  pushPublicKey?: string;
  draftRetentionDays: 7;
};

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[+-]/, 1)[0].split(".").map((part) => Number(part));
  const leftParts = parse(left); const rightParts = parse(right);
  if (leftParts.length !== 3 || rightParts.length !== 3 || [...leftParts, ...rightParts].some((part) => !Number.isInteger(part) || part < 0)) throw new Error("CLIENT_VERSION_INVALID");
  for (let index = 0; index < 3; index += 1) if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  return 0;
}

export function clientPolicyFromEnvironment(env: NodeJS.ProcessEnv = process.env): ClientPolicy {
  const offline = env.CLIENT_OFFLINE_DRAFTS === "internal" ? "internal" : "disabled";
  const minimumVersion = env.CLIENT_MIN_VERSION || "0.9.0";
  compareVersions(minimumVersion, minimumVersion);
  return {
    minimumVersion,
    managedDeviceRequired: env.CLIENT_MANAGED_DEVICE_REQUIRED === "true",
    offlineDrafts: offline,
    pushEnabled: env.CLIENT_PUSH_ENABLED === "true",
    pushPublicKey: env.CLIENT_PUSH_PUBLIC_KEY || undefined,
    draftRetentionDays: 7,
  };
}

export function revokeDevice(device: ClientDevice, now = new Date()): ClientDevice {
  if (device.status === "revoked") return device;
  return { ...device, status: "revoked", pushEnabled: false, revokedAt: now.toISOString(), version: device.version + 1 };
}
