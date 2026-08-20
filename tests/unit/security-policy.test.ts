// Requirements: PR-001, SR-007, AC-012
import { describe, expect, it } from "vitest";
import { getSecurityHeaders } from "@/src/platform/http/security-policy";

describe("security headers", () => {
  it("allows React development diagnostics without weakening production CSP", () => {
    const development = getSecurityHeaders({ NODE_ENV: "development" });
    const production = getSecurityHeaders({ NODE_ENV: "production" });

    expect(development["content-security-policy"]).toContain("'unsafe-eval'");
    expect(production["content-security-policy"]).not.toContain("'unsafe-eval'");
    expect(production["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("does not upgrade HTTP requests in the explicit LAN profile", () => {
    const headers = getSecurityHeaders({ NODE_ENV: "production", NEXUS_DEPLOYMENT_MODE: "lan", PUBLIC_APP_ORIGIN: "http://192.168.1.20:3117" });
    expect(headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  });
});
