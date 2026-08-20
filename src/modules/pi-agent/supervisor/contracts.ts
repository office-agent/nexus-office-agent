import type {
  PiSandbox,
  PiSandboxProvider,
} from "@/src/modules/pi-agent/domain/contracts";
import type { PiSandboxRunTokenScope } from "@/src/modules/pi-agent/application/sandbox-token";

export type PiSandboxSupervisorBackend = PiSandboxProvider & {
  readonly kind: "firecracker" | "kata";
  readiness(): Promise<{ ready: true } | { ready: false; code: string }>;
};

export type PiSandboxBinding = {
  sandbox: PiSandbox;
  scope: PiSandboxRunTokenScope;
  createdAt: string;
};

export interface PiSandboxBindingStore {
  initialize(): Promise<void>;
  get(sandboxId: string): Promise<PiSandboxBinding | null>;
  put(binding: PiSandboxBinding): Promise<void>;
  delete(sandboxId: string): Promise<void>;
}
