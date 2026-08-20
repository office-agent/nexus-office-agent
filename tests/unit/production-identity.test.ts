// Requirements: MR-008, MR-009, AR-001, SR-001, SR-002, SR-004, SR-005, AC-003
import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOidcState, exchangeOidcCallback, verifyOidcState, type OidcConfiguration } from "@/src/platform/identity/oidc";
import { createSessionCookieValue, verifySessionCookieValue, verifySessionCookieWithRotation } from "@/src/platform/identity/session";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";

const secret = "0123456789abcdef0123456789abcdef";

afterEach(() => vi.unstubAllEnvs());

describe("production identity", () => {
  it("signs, expires and rejects tampered enterprise sessions", () => {
    const value = createSessionCookieValue({ tenantId: "tenant-a", actorId: "user-a", channel: "web", roles: ["manager"], permissions: ["project:read"], dataScopes: [{ type: "team", teamIds: ["team-a"] }] }, secret, { now: new Date("2026-08-05T00:00:00Z"), ttlSeconds: 60 });
    expect(verifySessionCookieValue(value, secret, new Date("2026-08-05T00:00:30Z")).tenantId).toBe("tenant-a");
    expect(() => verifySessionCookieValue(`${value}x`, secret, new Date("2026-08-05T00:00:30Z"))).toThrow("SESSION_INVALID");
    expect(() => verifySessionCookieValue(value, secret, new Date("2026-08-05T00:01:01Z"))).toThrow("SESSION_INVALID");
    expect(verifySessionCookieWithRotation(value, ["abcdef0123456789abcdef0123456789", secret], new Date("2026-08-05T00:00:30Z")).actorId).toBe("user-a");
  });

  it("re-resolves production permissions on every request and ignores stale signed grants", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXUS_ALLOW_DEMO_IDENTITY", "false"); vi.stubEnv("SESSION_SECRET", secret);
    const session = createSessionCookieValue({ tenantId: "tenant-authorized", actorId: "actor-authorized", channel: "web", roles: ["manager"], permissions: ["project:read"], dataScopes: [{ type: "tenant" }] }, secret);
    const request = new Request("https://office.example/api", { headers: { cookie: `nexus_session=${session}`, "x-tenant-id": "tenant-attacker", "x-user-id": "attacker" } });
    const resolver = { resolve: vi.fn(async () => ({ roles: ["auditor"], permissions: ["audit_event:read"], dataScopes: [{ type: "self" as const }] })) };
    await expect(resolveRequestContext(request, resolver)).resolves.toMatchObject({ tenantId: "tenant-authorized", actorId: "actor-authorized", roles: ["auditor"], permissions: ["audit_event:read"], dataScopes: [{ type: "self" }] });
    expect(resolver.resolve).toHaveBeenCalledWith("tenant-authorized", "actor-authorized");
  });

  it("invalidates a correctly signed session when the authoritative user is no longer active", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXUS_ALLOW_DEMO_IDENTITY", "false"); vi.stubEnv("SESSION_SECRET", secret);
    const session = createSessionCookieValue({ tenantId: "tenant-authorized", actorId: "departed-user", channel: "web", roles: ["manager"], permissions: ["*"], dataScopes: [{ type: "tenant" }] }, secret);
    const request = new Request("https://office.example/api", { headers: { cookie: `nexus_session=${session}` } });
    await expect(resolveRequestContext(request, { resolve: async () => null })).rejects.toThrow("AUTHENTICATION_REQUIRED");
  });

  it("completes PKCE/nonce/signed-token flow only for an explicitly provisioned subject", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig", alg: "RS256" };
    const config: OidcConfiguration = {
      issuer: "https://idp.example",
      clientId: "nexus-client",
      clientSecret: "client-secret",
      redirectUri: "https://office.example/api/v1/auth/callback",
      sessionSecret: secret,
      stateSecret: secret,
      subjectMappings: {
        "https://idp.example::subject-1": { tenantId: "tenant-a", actorId: "actor-a", roles: ["manager"], permissions: ["project:read"], dataScopes: [{ type: "tenant" }] },
      },
    };
    const now = new Date("2026-08-05T00:00:00Z");
    const created = createOidcState(config, "https://attacker.example", now);
    const state = verifyOidcState(created.value, created.state.state, config, now);
    expect(state.returnTo).toBe("/");
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: config.issuer, sub: "subject-1", aud: config.clientId, exp: Math.floor(now.getTime() / 1000) + 300, iat: Math.floor(now.getTime() / 1000), nonce: state.nonce })).toString("base64url");
    const signer = createSign("RSA-SHA256"); signer.update(`${header}.${claims}`); signer.end();
    const idToken = `${header}.${claims}.${signer.sign(createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" }))).toString("base64url")}`;
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`, jwks_uri: `${config.issuer}/jwks` });
      if (url.endsWith("/token")) return Response.json({ id_token: idToken });
      if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const result = await exchangeOidcCallback({ code: "authorization-code", state, config, fetcher: fakeFetch, now });
    expect(verifySessionCookieValue(result.session, secret, now)).toMatchObject({ tenantId: "tenant-a", actorId: "actor-a" });
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });
});
