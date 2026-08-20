// Requirements: PR-002, SR-003, SR-006, AC-006, AC-007
import { describe, expect, it } from "vitest";
import { FakeModelGateway } from "@/src/modules/agent/domain/model-gateway";

describe("FakeModelGateway", () => {
  it("is deterministic for normal test traffic", async () => {
    const gateway = new FakeModelGateway("fixed");
    const result = await gateway.complete({
      tenantId: "tenant-a",
      traceId: "trace-1",
      messages: [{ role: "user", content: "hello" }],
      dataClassification: "internal",
    });
    expect(result).toMatchObject({ content: "fixed", provider: "fake", model: "deterministic-test-model" });
  });

  it("fails closed for restricted data", async () => {
    const gateway = new FakeModelGateway();
    await expect(
      gateway.complete({
        tenantId: "tenant-a",
        traceId: "trace-1",
        messages: [{ role: "user", content: "restricted" }],
        dataClassification: "restricted",
      }),
    ).rejects.toThrow("MODEL_POLICY_DENIED");
  });
});
