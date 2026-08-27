// Requirements: PR-002, PR-005, MR-016, MR-017, MR-018, MR-019, MR-020, MR-021, MR-022, MR-023, MR-024, MR-025, AR-002, AR-003, AC-002
import { describe, expect, it } from "vitest";
import { GET as getWorkspace } from "@/app/api/v1/governance/workspace/route";
import { POST as preReview } from "@/app/api/v1/workflows/process-instances/[id]/pre-review/route";
import { POST as decideApproval } from "@/app/api/v1/workflows/approvals/[id]/decide/route";
import { POST as prepareMeeting } from "@/app/api/v1/meetings/[id]/prepare/route";
import { POST as confirmMeeting } from "@/app/api/v1/meetings/[id]/confirm/route";
import { GET as searchKnowledge } from "@/app/api/v1/knowledge/search/route";
import { POST as publishDocument } from "@/app/api/v1/knowledge/documents/route";
import { DEMO_APPROVAL_ID, DEMO_PROCESS_INSTANCE_ID } from "@/src/modules/workflow/infrastructure/in-memory-repository";
import { DEMO_MEETING_ID } from "@/src/modules/collaboration/infrastructure/in-memory-meeting-repository";

function post(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-trace-id": "governance-api-test" }, body: JSON.stringify(body) });
}

describe("governance workspace HTTP API", () => {
  it("runs approval, meeting and knowledge journeys on one permission-aware workspace", async () => {
    const initialResponse = await getWorkspace(new Request("http://localhost/api/v1/governance/workspace"));
    const initial = await initialResponse.json();
    expect(initialResponse.status).toBe(200);
    expect(initial.data.workflow.pendingApprovals.map((item: { id: string }) => item.id)).toContain(DEMO_APPROVAL_ID);
    expect(initial.data.meetings[0].status).toBe("pending_confirmation");
    expect(initial.data.documents[0].classification).toBe("confidential");

    const reviewResponse = await preReview(
      post(`http://localhost/api/v1/workflows/process-instances/${DEMO_PROCESS_INSTANCE_ID}/pre-review`, {}),
      { params: Promise.resolve({ id: DEMO_PROCESS_INSTANCE_ID }) },
    );
    const review = await reviewResponse.json();
    expect(reviewResponse.status).toBe(200);
    expect(review.data).toMatchObject({ recommendation: "request_more_information", stateChanged: false });

    const approvalResponse = await decideApproval(
      post(`http://localhost/api/v1/workflows/approvals/${DEMO_APPROVAL_ID}/decide`, { decision: "approve", comment: "压测报告补齐后执行", version: 1 }),
      { params: Promise.resolve({ id: DEMO_APPROVAL_ID }) },
    );
    const approval = await approvalResponse.json();
    expect(approvalResponse.status).toBe(200);
    expect(approval.data.instance.status).toBe("approved");

    const preparedResponse = await prepareMeeting(post(`http://localhost/api/v1/meetings/${DEMO_MEETING_ID}/prepare`, {}), { params: Promise.resolve({ id: DEMO_MEETING_ID }) });
    const prepared = await preparedResponse.json();
    expect(preparedResponse.status).toBe(200);
    expect(prepared.data.stateChanged).toBe(false);
    expect(prepared.data.citations.length).toBeGreaterThan(0);

    const meetingResponse = await confirmMeeting(
      post(`http://localhost/api/v1/meetings/${DEMO_MEETING_ID}/confirm`, { version: 1 }),
      { params: Promise.resolve({ id: DEMO_MEETING_ID }) },
    );
    const meeting = await meetingResponse.json();
    expect(meetingResponse.status).toBe(200);
    expect(meeting.data.meeting).toMatchObject({ status: "confirmed", outcomeStatus: "materialized" });
    expect(meeting.data.decisionIds).toHaveLength(1);

    const searchResponse = await searchKnowledge(new Request("http://localhost/api/v1/knowledge/search?q=数据安全"));
    const search = await searchResponse.json();
    expect(searchResponse.status).toBe(200);
    expect(search.data[0]).toMatchObject({
      title: "客户数据安全分级制度", sourceRef: "policy:customer-data-security",
      accessBasis: "owner", untrustedContent: true,
    });
  });

  it("rejects malformed document publication", async () => {
    const response = await publishDocument(post("http://localhost/api/v1/knowledge/documents", { title: "x", content: "", classification: "secret" }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a document validity window that ends before it starts", async () => {
    const response = await publishDocument(post("http://localhost/api/v1/knowledge/documents", {
      title: "失效制度", content: "无效时间窗口", classification: "internal",
      effectiveAt: "2026-08-27T00:00:00.000Z", expiresAt: "2026-08-26T00:00:00.000Z",
    }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });
});
