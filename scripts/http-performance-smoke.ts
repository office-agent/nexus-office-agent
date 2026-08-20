import { benchmarkOperation } from "@/src/platform/operations/performance";

const baseUrl = (process.env.NEXUS_SMOKE_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

async function expectStatus(path: string, init: RequestInit, expected: number) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  if (response.status !== expected) throw new Error(`SMOKE_STATUS_FAILED:${path}:${response.status}`);
  await response.arrayBuffer();
}

async function main() {
  for (let index = 0; index < 10; index += 1) await expectStatus("/api/v1/management/snapshot", {}, 200);
  const reads = await benchmarkOperation(200, () => expectStatus("/api/v1/management/snapshot", {}, 200));
  let riskIndex = 0;
  const writes = await benchmarkOperation(80, () => expectStatus("/api/v1/management/risks", {
    method: "POST",
    body: JSON.stringify({ projectId: "30000000-0000-4000-8000-000000000001", title: `HTTP 性能样本 ${riskIndex += 1}`, description: "仅用于本地生产构建性能门禁的虚构数据", ownerId: "10000000-0000-4000-8000-000000000001", probability: 2, impact: 2, sourceType: "event" }),
  }, 201));
  const agent = await benchmarkOperation(20, () => expectStatus("/api/agent", { method: "POST", body: JSON.stringify({ message: "总结当前项目事实和风险" }) }, 200));
  const passed = reads.p95Ms < 500 && writes.p95Ms < 800 && agent.p95Ms < 4_000;
  process.stdout.write(JSON.stringify({ target: { readP95Ms: 500, writeP95Ms: 800, agentResponseP95Ms: 4_000 }, observed: { reads, writes, agent }, passed }) + "\n");
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ passed: false, code: error instanceof Error ? error.message : "PERFORMANCE_SMOKE_FAILED" }) + "\n");
  process.exitCode = 1;
});
