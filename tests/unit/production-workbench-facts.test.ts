// Requirements: DR-010
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const productionUiFiles = [
  "components/office-shell.tsx",
  "components/management-loop-view.tsx",
  "components/enterprise-governance-view.tsx",
  "components/enterprise-intelligence-view.tsx",
  "app/api/v1/management/snapshot/route.ts",
];

describe("production workbench fact discipline", () => {
  it("keeps production workbench facts behind authenticated APIs and explicit empty states", async () => {
    const sources = await Promise.all(productionUiFiles.map(async (file) => [file, await readFile(path.resolve(file), "utf8")] as const));
    const combined = sources.map(([file, source]) => `${file}\n${source}`).join("\n");

    for (const forbidden of ["DEMO_", "曜石科技", "林舟", "陈雪", "上海 ·", "团队在线", "智能客服 2.0", "46 条更新", "¥186,400"]) {
      expect(combined, `production UI contains seeded fact: ${forbidden}`).not.toContain(forbidden);
    }

    const shell = sources.find(([file]) => file === "components/office-shell.tsx")![1];
    expect(shell).toContain('/api/v1/workspace/bootstrap');
    expect(shell).toContain("当前没有可访问项目");
    expect(shell).toContain("development_fixture");
    expect(shell).toContain("monitorAgentJob");
    expect(shell).toContain('job.status === "succeeded"');
    expect(shell).toContain("提案已确认并进入安全执行队列，尚未标记为成功");

    const snapshotRoute = sources.find(([file]) => file === "app/api/v1/management/snapshot/route.ts")![1];
    expect(snapshotRoute).toContain("z.uuid().parse");
    expect(snapshotRoute).not.toContain("development-context");
  });
});
