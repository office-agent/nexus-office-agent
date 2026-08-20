// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiApprovalObjectVersionReader } from "@/src/modules/pi-agent/domain/approval-contracts";
import type { PiSession } from "@/src/modules/pi-agent/domain/contracts";
import { ApprovalPolicyResolver, InMemoryPiApprovalEventSink, PiApprovalService, StaticPiApprovalApproverDirectory, StaticPiApprovalObjectVersionReader } from "@/src/modules/pi-agent/application/approval-service";
import { InMemoryPiApprovalStore } from "@/src/modules/pi-agent/infrastructure/approval-store";
import { createPiEnterprisePolicyExtension } from "@/src/modules/pi-agent/infrastructure/enterprise-policy-extension";

const TENANT = "72000000-0000-4000-8000-000000000001";
const ACTOR = "72000000-0000-4000-8000-000000000002";
const APPROVER = "72000000-0000-4000-8000-000000000003";

function context(): RequestContext {
  return {
    tenantId: TENANT,
    actorId: ACTOR,
    sessionId: "72000000-0000-4000-8000-000000000099",
    channel: "web",
    traceId: "pi-enterprise-policy-test",
    roles: [],
    permissions: ["pi:approval:create", "pi:approval:read", "pi:approval:decide:r2", "pi:approval:resume"],
    dataScopes: [{ type: "tenant" }],
  };
}

function session(profile: PiSession["profile"] = "coding"): PiSession {
  return {
    id: "72000000-0000-4000-8000-000000000101",
    tenantId: TENANT,
    actorId: ACTOR,
    workspaceId: "72000000-0000-4000-8000-000000000201",
    profile,
    profileVersion: 1,
    status: "running",
    modelPolicy: "private-default",
    sandboxProfile: "virtual:coding",
    networkPolicy: "none",
    policyVersion: 9,
    skillDigests: [],
    mcpServerDigests: [],
    mcpBindingIds: [],
    mcpBindings: [],
    sandboxRunId: "72000000-0000-4000-8000-000000000301",
    traceId: "pi-enterprise-policy-test",
    lastEventSequence: 0,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function runtime(reader: PiApprovalObjectVersionReader = new StaticPiApprovalObjectVersionReader({ project: "v1" })) {
  const events = new InMemoryPiApprovalEventSink();
  const store = new InMemoryPiApprovalStore();
  const service = new PiApprovalService(
    store,
    new ApprovalPolicyResolver(new StaticPiApprovalApproverDirectory([APPROVER]), { policyVersion: 9, ttlMs: { R2: 10_000 } }),
    events,
    reader,
  );
  return { service, store, events };
}

async function handlerFor(options: Parameters<typeof createPiEnterprisePolicyExtension>[0]) {
  let handler: ((event: ToolCallEvent, ctx: { signal?: AbortSignal }) => Promise<void>) | undefined;
  const factory = createPiEnterprisePolicyExtension(options);
  await factory({
    on(event: string, callback: unknown) {
      if (event === "tool_call") handler = callback as typeof handler;
    },
  } as unknown as ExtensionAPI);
  if (!handler) throw new Error("TEST_POLICY_HANDLER_MISSING");
  return handler;
}

describe("Pi enterprise policy extension", () => {
  it("pauses an R2 tool before execution, then resumes only after approval", async () => {
    const s = session();
    const r = runtime();
    const required: string[] = [];
    const resumed: string[] = [];
    const handler = await handlerFor({
      context: context(),
      record: s,
      runId: "72000000-0000-4000-8000-000000000401",
      approvalService: r.service,
      approvalObjectVersions: { project: "v1" },
      pollMs: 5,
      waitTimeoutMs: 2_000,
      onApprovalRequired: ({ approval }) => { required.push(approval.id); },
      onApprovalResumed: ({ approval }) => { resumed.push(approval.id); },
    });
    const pending = handler({ type: "tool_call", toolName: "workspace_run", toolCallId: "tool-1", input: { command: "npm test" } }, {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    const approvals = await r.service.list({ ...context(), permissions: ["pi:approval:read"] });
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe("pending");
    await r.service.recordDecision({ ...context(), actorId: APPROVER, permissions: ["pi:approval:decide:r2"] }, approvals[0].id, { proposalHash: approvals[0].proposalHash, idempotencyKey: "decision-1" });
    await pending;
    expect(required).toEqual([approvals[0].id]);
    expect(resumed).toEqual([approvals[0].id]);
    expect((await r.service.get(context(), approvals[0].id)).revalidationStatus).toBe("passed");
  });

  it("fails closed for unknown tools and high-risk tools without an approval runtime", async () => {
    const s = session();
    const unknown = await handlerFor({ context: context(), record: s, runId: "72000000-0000-4000-8000-000000000402" });
    await expect(unknown({ type: "tool_call", toolName: "host_shell", toolCallId: "tool-2", input: {} }, {})).rejects.toThrow("PI_TOOL_NOT_IN_MANIFEST");
    const noApproval = await handlerFor({ context: context(), record: s, runId: "72000000-0000-4000-8000-000000000403" });
    await expect(noApproval({ type: "tool_call", toolName: "workspace_run", toolCallId: "tool-3", input: { command: "whoami" } }, {})).rejects.toThrow("PI_APPROVAL_RUNTIME_UNAVAILABLE");
  });

  it("does not execute after rejection or object-version drift", async () => {
    const s = session();
    const r = runtime();
    const denied = await handlerFor({ context: context(), record: s, runId: "72000000-0000-4000-8000-000000000404", approvalService: r.service, approvalObjectVersions: { project: "v1" }, pollMs: 5, waitTimeoutMs: 1_000 });
    const pending = denied({ type: "tool_call", toolName: "workspace_run", toolCallId: "tool-4", input: { command: "deploy" } }, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const approval = (await r.service.list({ ...context(), permissions: ["pi:approval:read"] }))[0];
    await r.service.reject({ ...context(), actorId: APPROVER, permissions: ["pi:approval:decide:r2"] }, approval.id, { proposalHash: approval.proposalHash, idempotencyKey: "decision-reject", comment: "风险未确认" });
    await expect(pending).rejects.toThrow("PI_APPROVAL_DENIED:rejected");

    let versions = { project: "v1" };
    const reader: PiApprovalObjectVersionReader = { read: async () => versions };
    const drift = runtime(reader);
    const driftHandler = await handlerFor({ context: context(), record: s, runId: "72000000-0000-4000-8000-000000000405", approvalService: drift.service, approvalObjectVersions: versions, pollMs: 5, waitTimeoutMs: 1_000 });
    const driftPending = driftHandler({ type: "tool_call", toolName: "workspace_run", toolCallId: "tool-5", input: { command: "npm test" } }, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const driftApproval = (await drift.service.list({ ...context(), permissions: ["pi:approval:read"] }))[0];
    await drift.service.recordDecision({ ...context(), actorId: APPROVER, permissions: ["pi:approval:decide:r2"] }, driftApproval.id, { proposalHash: driftApproval.proposalHash, idempotencyKey: "decision-drift" });
    versions = { project: "v2" };
    await expect(driftPending).rejects.toThrow("PI_APPROVAL_REVALIDATION_FAILED");
    expect((await drift.service.get(context(), driftApproval.id)).status).toBe("superseded");
  });

  it("stops the approval wait when the Pi run is interrupted", async () => {
    const r = runtime();
    const controller = new AbortController();
    const handler = await handlerFor({
      context: context(),
      record: session(),
      runId: "72000000-0000-4000-8000-000000000408",
      approvalService: r.service,
      approvalObjectVersions: { project: "v1" },
      pollMs: 5,
      waitTimeoutMs: 1_000,
    });
    const pending = handler({ type: "tool_call", toolName: "workspace_run", toolCallId: "tool-9", input: { command: "npm test" } }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow("PI_APPROVAL_WAIT_ABORTED");
  });

  it("allows R0/R1 reads and writes without approval, while release shell is R3", async () => {
    const r = runtime();
    const coding = await handlerFor({ context: context(), record: session(), runId: "72000000-0000-4000-8000-000000000406", approvalService: r.service, approvalObjectVersions: { project: "v1" } });
    await coding({ type: "tool_call", toolName: "workspace_read", toolCallId: "tool-6", input: { path: "README.md" } }, {});
    await coding({ type: "tool_call", toolName: "workspace_write", toolCallId: "tool-7", input: { path: "a.txt", content: "x" } }, {});
    const release = await handlerFor({ context: context(), record: session("release"), runId: "72000000-0000-4000-8000-000000000407", approvalService: undefined });
    await expect(release({ type: "tool_call", toolName: "workspace_run", toolCallId: "tool-8", input: { command: "npm publish" } }, {})).rejects.toThrow("PI_APPROVAL_RUNTIME_UNAVAILABLE");
  });
});
