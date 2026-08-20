import { isIP } from "node:net";
import type {
  PiCompiledEgressPolicy,
  PiEgressDestination,
  PiEgressPolicy,
} from "@/src/modules/pi-agent/domain/contracts";
import { sha256, stableJson } from "@/src/modules/pi-agent/application/manifest";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data.ec2.internal",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

function normalizeHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || host.includes("*") || host.includes("/") || host.includes("\\") || host.includes(":")) {
    throw new Error("PI_EGRESS_HOST_INVALID");
  }
  if (isIP(host) !== 0 || BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".svc") || host.endsWith(".cluster.local")) {
    throw new Error("PI_EGRESS_DESTINATION_BLOCKED");
  }
  if (!host.includes(".") || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    throw new Error("PI_EGRESS_HOST_INVALID");
  }
  return host;
}

function normalizeDestination(destination: PiEgressDestination): PiEgressDestination {
  const ports = [...new Set(destination.ports)].sort((left, right) => left - right);
  if (!ports.length || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("PI_EGRESS_PORT_INVALID");
  }
  const protocols = [...new Set(destination.protocols?.length ? destination.protocols : ["tcp" as const])].sort();
  if (protocols.some((protocol) => protocol !== "tcp" && protocol !== "udp")) throw new Error("PI_EGRESS_PROTOCOL_INVALID");
  return { host: normalizeHost(destination.host), ports, protocols };
}

function normalizeProxyRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ref = value.trim();
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(ref)) throw new Error("PI_EGRESS_PROXY_REF_INVALID");
  return ref;
}

export class EgressPolicyCompiler {
  compile(input: PiEgressPolicy): PiCompiledEgressPolicy {
    const proxyRef = normalizeProxyRef(input.proxyRef);
    const destinations = [...(input.destinations ?? [])].map(normalizeDestination)
      .sort((left, right) => `${left.host}:${left.ports.join(",")}`.localeCompare(`${right.host}:${right.ports.join(",")}`));
    if (destinations.length > 32) throw new Error("PI_EGRESS_DESTINATION_LIMIT");

    if (input.mode === "none") {
      if (destinations.length || proxyRef) throw new Error("PI_EGRESS_NONE_MUST_NOT_HAVE_ALLOWLIST");
    } else if (!proxyRef) {
      throw new Error("PI_EGRESS_PROXY_REQUIRED");
    } else if (input.mode === "allowlist" && !destinations.length) {
      throw new Error("PI_EGRESS_ALLOWLIST_EMPTY");
    } else if (input.mode === "restricted" && destinations.length) {
      throw new Error("PI_EGRESS_RESTRICTED_DIRECT_DESTINATION");
    }

    const unsigned = {
      mode: input.mode,
      defaultAction: "deny" as const,
      dnsMode: input.mode === "none" ? "deny" as const : "proxy-only" as const,
      metadataBlocked: true as const,
      directEgress: false as const,
      destinations,
      ...(proxyRef ? { proxyRef } : {}),
    };
    return { ...unsigned, digest: sha256(stableJson(unsigned)) };
  }
}

export const defaultEgressPolicyCompiler = new EgressPolicyCompiler();
