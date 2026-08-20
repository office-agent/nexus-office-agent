// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { describe, expect, it } from "vitest";
import type { PiPullRequestGatewayInput } from "@/src/modules/pi-agent/domain/change-delivery-contracts";
import { ForgejoPiChangeDeliveryGateway, type PiForgejoCredentialResolver } from "@/src/modules/pi-agent/infrastructure/change-delivery-gateway";

const TENANT = "81000000-0000-4000-8000-000000000001";
const INPUT: PiPullRequestGatewayInput = {
  tenantId: TENANT,
  actorId: "81000000-0000-4000-8000-000000000002",
  sessionId: "81000000-0000-4000-8000-000000000101",
  runId: "81000000-0000-4000-8000-000000000102",
  repositoryId: "81000000-0000-4000-8000-000000000104",
  provider: "forgejo",
  repositoryRef: "team/project-a",
  credentialRef: `secret://tenants/${TENANT}/forgejo/project-a`,
  branch: "pi/81000000/change",
  targetBranch: "main",
  baseCommitSha: "a".repeat(40),
  headCommitSha: "b".repeat(40),
  changeSetDigest: "c".repeat(64),
  idempotencyKey: "pi-change-pr:81000000",
  traceId: "trace-pi-change-gateway",
};

class CredentialResolver implements PiForgejoCredentialResolver {
  readonly scopes: string[] = [];
  async resolve(input: Parameters<PiForgejoCredentialResolver["resolve"]>[0]): Promise<string> {
    this.scopes.push(`${input.tenantId}:${input.credentialRef}`);
    return "forgejo-test-token";
  }
}

function pull(number: number, mergeable = true): Record<string, unknown> {
  return { number, html_url: `https://forgejo.example.test/team/project-a/pulls/${number}`, state: "open", mergeable, head: { ref: INPUT.branch }, base: { ref: INPUT.targetBranch } };
}

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Forgejo Change Delivery gateway", () => {
  it("discovers an existing PR before creating and keeps credentials out of request bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const resolver = new CredentialResolver();
    const gateway = new ForgejoPiChangeDeliveryGateway({
      apiEndpoint: "https://forgejo.example.test/api/v1",
      credentialResolver: resolver,
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return calls.length === 1 ? response([pull(7)]) : response({ message: "unexpected" }, 500);
      },
    });

    const result = await gateway.createPullRequest(INPUT);
    expect(result).toMatchObject({ status: "succeeded", externalId: "7", externalUrl: "https://forgejo.example.test/team/project-a/pulls/7", mergeability: "mergeable" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("state=open");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("token forgejo-test-token");
    expect(JSON.stringify(calls)).not.toContain(INPUT.changeSetDigest);
    expect(resolver.scopes).toEqual([`${TENANT}:${INPUT.credentialRef}`]);
  });

  it("creates, refreshes and merges only the scoped PR", async () => {
    const calls: string[] = [];
    const gateway = new ForgejoPiChangeDeliveryGateway({
      apiEndpoint: "https://forgejo.example.test/api/v1",
      credentialResolver: new CredentialResolver(),
      allowMerge: true,
      fetcher: async (url, init) => {
        calls.push(`${init?.method}:${String(url)}`);
        if (calls.length === 1) return response([]);
        if (calls.length === 2) return response(pull(8), 201);
        if (calls.length === 3) return response({ ...pull(8), mergeable_state: "dirty", mergeable: false });
        return response(undefined, 204);
      },
    });

    const created = await gateway.createPullRequest(INPUT);
    expect(created).toMatchObject({ status: "succeeded", externalId: "8" });
    const refreshed = await gateway.refreshMergeability({ ...INPUT, externalId: "8", idempotencyKey: "pi-change-refresh" });
    expect(refreshed).toMatchObject({ status: "succeeded", mergeability: "conflicted" });
    const merged = await gateway.proposeMerge({ ...INPUT, externalId: "8", pullRequestId: "pull-request-8", idempotencyKey: "pi-change-merge" });
    expect(merged).toMatchObject({ status: "succeeded", externalId: "8" });
    expect(calls.map((call) => call.split(":")[0])).toEqual(["GET", "POST", "GET", "POST"]);
  });

  it("returns deterministic failures for authorization and stays fail-closed for disabled merge", async () => {
    const gateway = new ForgejoPiChangeDeliveryGateway({
      apiEndpoint: "https://forgejo.example.test/api/v1",
      credentialResolver: new CredentialResolver(),
      fetcher: async () => response({ message: "token must never be surfaced" }, 401),
    });
    await expect(gateway.createPullRequest(INPUT)).resolves.toMatchObject({ status: "failed", errorCode: "PI_FORGEJO_AUTH_FAILED" });
    await expect(gateway.proposeMerge({ ...INPUT, externalId: "8", pullRequestId: "pull-request-8" })).rejects.toThrow("PI_CHANGE_RELEASE_GATEWAY_DISABLED");
    await expect(gateway.proposeRelease({ ...INPUT, externalId: "8", pullRequestId: "pull-request-8", environment: "staging", artifactDigest: "d".repeat(64), releaseProposalId: "release-8" })).rejects.toThrow("PI_CHANGE_RELEASE_GATEWAY_UNAVAILABLE");
  });

  it("does not convert a network ambiguity into a false success", async () => {
    const gateway = new ForgejoPiChangeDeliveryGateway({
      apiEndpoint: "https://forgejo.example.test/api/v1",
      credentialResolver: new CredentialResolver(),
      fetcher: async () => { throw new Error("socket details must not escape"); },
    });
    await expect(gateway.createPullRequest(INPUT)).rejects.toThrow("PI_FORGEJO_UPSTREAM_UNKNOWN");
  });
});
