// Requirements: PR-001, AR-007, DR-012
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REQUIREMENT_PATTERN = /\b(?:PR|MR|AR|IR|SR|AC|DR)-\d{3}\b/g;

type EvidenceManifest = {
  schemaVersion: number;
  release: string;
  verificationCommand: string;
  evidence: Array<{ requirements: string[]; file: string; testName: string; failureMode: string }>;
  pending: Array<{ requirement: string; reason: string; unblock: string }>;
  externalGates: Record<string, string>;
};

function expectedRequirementIds(): string[] {
  const ranges = [["PR", 12], ["MR", 50], ["AR", 12], ["IR", 7], ["SR", 7], ["AC", 13], ["DR", 14]] as const;
  return ranges.flatMap(([prefix, count]) => Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`));
}

async function filesUnder(directory: string, suffix: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const location = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(location, suffix) : Promise.resolve(entry.name.endsWith(suffix) ? [location] : []);
  }));
  return nested.flat();
}

describe("requirement traceability gate", () => {
  it("keeps the design corpus aligned to the canonical 115 requirement IDs", async () => {
    const documents = await filesUnder(path.resolve("docs"), ".md");
    const discovered = new Set<string>();
    for (const document of documents) for (const id of (await readFile(document, "utf8")).match(REQUIREMENT_PATTERN) ?? []) discovered.add(id);
    expect([...discovered].sort()).toEqual(expectedRequirementIds().sort());
  });

  it("keeps test-file requirement headers as valid navigation metadata", async () => {
    const expected = new Set(expectedRequirementIds());
    const tests = await filesUnder(path.resolve("tests"), ".test.ts");
    for (const test of tests) {
      const relative = path.relative(process.cwd(), test).replaceAll("\\", "/");
      const firstLine = (await readFile(test, "utf8")).split(/\r?\n/, 1)[0];
      expect(firstLine, `${relative} 必须在首行声明 Requirements`).toMatch(/^\/\/ Requirements: /);
      const ids = firstLine.match(REQUIREMENT_PATTERN) ?? [];
      expect(ids.length, `${relative} 至少关联一个需求`).toBeGreaterThan(0);
      for (const id of ids) expect(expected.has(id), `${relative} 引用了未知需求 ${id}`).toBe(true);
    }
  });

  it("binds every implemented requirement to an exact executable behavior and failure mode", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("tests/behavior-evidence.json"), "utf8")) as EvidenceManifest;
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string; scripts: Record<string, string> };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.release).toBe(packageJson.version);
    expect(manifest.verificationCommand).toBe("npm run test");
    expect(packageJson.scripts.test).toBe("vitest run");

    const expected = new Set(expectedRequirementIds());
    const covered = new Set<string>();
    for (const item of manifest.evidence) {
      expect(item.requirements.length).toBeGreaterThan(0);
      expect(item.failureMode.trim().length).toBeGreaterThanOrEqual(12);
      expect(item.file.startsWith("tests/") && !item.file.includes(".."), `${item.file} 必须是 tests 下的安全相对路径`).toBe(true);
      const source = await readFile(path.resolve(item.file), "utf8");
      const exactTest = source.includes(`it("${item.testName}"`) || source.includes(`test("${item.testName}"`);
      expect(exactTest, `${item.file} 不存在精确测试：${item.testName}`).toBe(true);
      for (const requirement of item.requirements) {
        expect(expected.has(requirement), `行为证据引用未知需求 ${requirement}`).toBe(true);
        covered.add(requirement);
      }
    }

    const pending = new Set(manifest.pending.map(({ requirement }) => requirement));
    expect([...pending]).toEqual([]);
    for (const item of manifest.pending) {
      expect(expected.has(item.requirement)).toBe(true);
      expect(covered.has(item.requirement), `${item.requirement} 不得同时标为已实现和待完成`).toBe(false);
      expect(item.reason.trim().length).toBeGreaterThanOrEqual(20);
      expect(item.unblock.trim().length).toBeGreaterThanOrEqual(20);
    }
    expect([...expected].filter((id) => !covered.has(id) && !pending.has(id))).toEqual([]);
  });

  it("keeps external acceptance truth explicit instead of converting local evidence into a completion claim", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("tests/behavior-evidence.json"), "utf8")) as EvidenceManifest;
    expect(Object.keys(manifest.externalGates).sort()).toEqual(["AC-001", "AC-010"]);
    expect(Object.values(manifest.externalGates).every((description) => description.includes("不替代"))).toBe(true);
  });
});
