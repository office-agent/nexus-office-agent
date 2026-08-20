import type { ClientDevice, EncryptedPushSubscription } from "@/src/modules/client-platform/domain/client-device";

export interface ClientPlatformRepository {
  listDevices(tenantId: string, userId: string): Promise<ClientDevice[]>;
  getDevice(tenantId: string, deviceId: string): Promise<ClientDevice | undefined>;
  getByInstallation(tenantId: string, userId: string, installationId: string): Promise<ClientDevice | undefined>;
  saveDevice(device: ClientDevice): Promise<void>;
  savePushSubscription(subscription: EncryptedPushSubscription): Promise<void>;
  revokePushSubscriptions(tenantId: string, deviceId: string, revokedAt: string): Promise<void>;
}
