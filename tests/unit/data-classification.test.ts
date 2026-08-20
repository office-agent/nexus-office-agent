// Requirements: SR-003, SR-006
import { describe, expect, it } from "vitest";
import { classifyUntrustedText, hasSensitiveContent } from "@/src/platform/security/data-classification";

describe("data classification boundary", () => {
  it("does not treat platform UUIDs as payment-card-like sensitive values", () => {
    expect(classifyUntrustedText("任务 00000000-0000-4000-8000-000000000001 已发布。")).toBe("internal");
  });

  it("still detects explicit access tokens before persistence or model egress", () => {
    expect(hasSensitiveContent("访问令牌: sk_example_sensitive_token")).toBe(true);
    expect(classifyUntrustedText("访问令牌: sk_example_sensitive_token")).toBe("restricted");
  });
});
