import type { ClientPlatformRepository } from "@/src/modules/client-platform/application/contracts";
import type { ClientDevice, EncryptedPushSubscription } from "@/src/modules/client-platform/domain/client-device";

export class InMemoryClientPlatformRepository implements ClientPlatformRepository {
  readonly devices = new Map<string, ClientDevice>();
  readonly subscriptions = new Map<string, EncryptedPushSubscription>();

  async listDevices(tenantId: string, userId: string): Promise<ClientDevice[]> {
    return [...this.devices.values()].filter((device) => device.tenantId === tenantId && device.userId === userId).sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)).map((device) => ({ ...device }));
  }
  async getDevice(tenantId: string, deviceId: string): Promise<ClientDevice | undefined> {
    const device = this.devices.get(deviceId); return device?.tenantId === tenantId ? { ...device } : undefined;
  }
  async getByInstallation(tenantId: string, userId: string, installationId: string): Promise<ClientDevice | undefined> {
    const device = [...this.devices.values()].find((candidate) => candidate.tenantId === tenantId && candidate.userId === userId && candidate.installationId === installationId);
    return device ? { ...device } : undefined;
  }
  async saveDevice(device: ClientDevice): Promise<void> { this.devices.set(device.id, { ...device }); }
  async savePushSubscription(subscription: EncryptedPushSubscription): Promise<void> {
    for (const [id, current] of this.subscriptions) if (current.tenantId === subscription.tenantId && current.endpointDigest === subscription.endpointDigest) this.subscriptions.delete(id);
    this.subscriptions.set(subscription.id, { ...subscription });
  }
  async revokePushSubscriptions(tenantId: string, deviceId: string, revokedAt: string): Promise<void> {
    for (const [id, current] of this.subscriptions) if (current.tenantId === tenantId && current.deviceId === deviceId && current.status === "active") this.subscriptions.set(id, { ...current, status: "revoked", revokedAt, version: current.version + 1 });
  }
}
