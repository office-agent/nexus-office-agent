import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { ClientPlatformRepository } from "@/src/modules/client-platform/application/contracts";
import { clientPolicyFromEnvironment, compareVersions, revokeDevice, type ClientDevice, type ClientPolicy, type EncryptedPushSubscription } from "@/src/modules/client-platform/domain/client-device";

function requirePermission(context: RequestContext, permission: string): void {
  if (!context.permissions.includes(permission)) throw new Error(`POLICY_DENIED:${permission}`);
}

export class ClientPlatformService {
  constructor(private readonly repository: ClientPlatformRepository, private readonly policy: ClientPolicy = clientPolicyFromEnvironment()) {}

  async bootstrap(context: RequestContext, installationId?: string, appVersion?: string) {
    requirePermission(context, "client:bootstrap:read");
    const device = installationId ? await this.repository.getByInstallation(context.tenantId, context.actorId, installationId) : undefined;
    const versionSupported = appVersion ? compareVersions(appVersion, this.policy.minimumVersion) >= 0 : false;
    const trustedEnough = !this.policy.managedDeviceRequired || device?.trustLevel === "managed" || device?.trustLevel === "attested";
    return {
      policy: this.policy,
      versionSupported,
      device,
      features: {
        offlineDrafts: Boolean(device?.status === "active" && versionSupported && trustedEnough && this.policy.offlineDrafts === "internal"),
        push: Boolean(device?.status === "active" && versionSupported && trustedEnough && this.policy.pushEnabled),
      },
      shortcuts: [
        { id: "today", label: "今日工作台", path: "/?view=today" },
        { id: "projects", label: "项目与任务", path: "/?view=projects" },
        { id: "approvals", label: "智能审批", path: "/?view=approvals" },
        { id: "inbox", label: "统一收件箱", path: "/?view=inbox" },
      ],
    };
  }

  async listDevices(context: RequestContext): Promise<ClientDevice[]> {
    requirePermission(context, "client:device:read");
    return this.repository.listDevices(context.tenantId, context.actorId);
  }

  async registerDevice(context: RequestContext, input: Pick<ClientDevice, "installationId" | "displayName" | "clientType" | "platform" | "appVersion">, now = new Date()): Promise<ClientDevice> {
    requirePermission(context, "client:device:register");
    const existing = await this.repository.getByInstallation(context.tenantId, context.actorId, input.installationId);
    if (existing?.status === "revoked") throw new Error("CLIENT_DEVICE_REVOKED");
    const versionSupported = compareVersions(input.appVersion, this.policy.minimumVersion) >= 0;
    const timestamp = now.toISOString();
    const device: ClientDevice = existing ? {
      ...existing, ...input, lastSeenAt: timestamp, status: versionSupported && !this.policy.managedDeviceRequired ? "active" : "pending", version: existing.version + 1,
    } : {
      id: randomUUID(), tenantId: context.tenantId, userId: context.actorId, ...input,
      trustLevel: "unmanaged", status: versionSupported && !this.policy.managedDeviceRequired ? "active" : "pending", pushEnabled: false,
      lastSeenAt: timestamp, registeredAt: timestamp, version: 1,
    };
    await this.repository.saveDevice(device);
    return device;
  }

  async revoke(context: RequestContext, deviceId: string, now = new Date()): Promise<ClientDevice> {
    requirePermission(context, "client:device:revoke");
    const current = await this.repository.getDevice(context.tenantId, deviceId);
    if (!current) throw new Error("CLIENT_DEVICE_NOT_FOUND");
    if (current.userId !== context.actorId && !context.permissions.includes("client:device:admin")) throw new Error("POLICY_DENIED:client:device:ownership");
    const revoked = revokeDevice(current, now);
    await this.repository.saveDevice(revoked);
    await this.repository.revokePushSubscriptions(context.tenantId, revoked.id, now.toISOString());
    return revoked;
  }

  async subscribe(context: RequestContext, deviceId: string, subscription: Omit<EncryptedPushSubscription, "id" | "tenantId" | "userId" | "deviceId" | "status" | "createdAt" | "version">, now = new Date()): Promise<void> {
    requirePermission(context, "client:push:subscribe");
    const device = await this.repository.getDevice(context.tenantId, deviceId);
    if (!device) throw new Error("CLIENT_DEVICE_NOT_FOUND");
    if (device.userId !== context.actorId) throw new Error("POLICY_DENIED:client:device:ownership");
    if (!this.policy.pushEnabled || device.status !== "active") throw new Error("CLIENT_PUSH_DISABLED");
    await this.repository.savePushSubscription({ id: randomUUID(), tenantId: context.tenantId, userId: context.actorId, deviceId, ...subscription, status: "active", createdAt: now.toISOString(), version: 1 });
    await this.repository.saveDevice({ ...device, pushEnabled: true, lastSeenAt: now.toISOString(), version: device.version + 1 });
  }

  async unsubscribe(context: RequestContext, deviceId: string, now = new Date()): Promise<void> {
    requirePermission(context, "client:push:subscribe");
    const device = await this.repository.getDevice(context.tenantId, deviceId);
    if (!device) throw new Error("CLIENT_DEVICE_NOT_FOUND");
    if (device.userId !== context.actorId) throw new Error("POLICY_DENIED:client:device:ownership");
    await this.repository.revokePushSubscriptions(context.tenantId, deviceId, now.toISOString());
    await this.repository.saveDevice({ ...device, pushEnabled: false, lastSeenAt: now.toISOString(), version: device.version + 1 });
  }
}
