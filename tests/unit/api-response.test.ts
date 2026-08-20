// Requirements: SR-004, PR-008
import { describe, expect, it } from "vitest";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

describe("application error responses", () => {
  it("returns a business conflict instead of a server error before an organization change is effective", async () => {
    const response = applicationErrorResponse(new Error("ORGANIZATION_CHANGE_NOT_EFFECTIVE"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ORGANIZATION_CHANGE_NOT_EFFECTIVE",
        message: "组织异动尚未到生效时间，当前不能执行交接。",
      },
    });
  });
});
