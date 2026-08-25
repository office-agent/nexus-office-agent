// Requirements: AC-009
import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { InMemoryManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_PROJECT_ID } from "@/src/platform/context/development-context";
import { benchmarkOperation } from "@/src/platform/operations/performance";

describe("local performance acceptance", () => {
  it("keeps core in-process reads and writes inside architecture ceilings", async () => {
    const service = new ManagementLoopService(new InMemoryManagementLoopRepository(new InMemoryEventStore()));
    const context = createDevelopmentRequestContext("performance-trace");
    const reads = await benchmarkOperation(300, () => service.getSnapshot(context, DEMO_PROJECT_ID));
    let writeIndex = 0;
    const writes = await benchmarkOperation(100, () => service.identifyRisk(context, {
      projectId: DEMO_PROJECT_ID, title: `性能样本 ${writeIndex += 1}`, description: "虚构压测数据", ownerId: DEMO_MANAGER_ID,
      probability: 2, impact: 2, sourceType: "event",
    }));
    expect(reads.p95Ms).toBeLessThan(500);
    expect(writes.p95Ms).toBeLessThan(800);
    expect({ reads, writes }).toMatchObject({ reads: { samples: 300 }, writes: { samples: 100 } });
  });
});
