import { z } from "zod";

const concise = (label: string, max = 4_000) => z.string().trim().min(2, `${label}不能为空`).max(max, `${label}过长`);
const lines = (label: string, maxItems = 40) => z.array(concise(label, 1_000)).min(1, `至少填写一项${label}`).max(maxItems);

export const developmentHandoffSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z][A-Za-z0-9._-]*$/, "项目编码格式不正确"),
  name: concise("项目名称", 120),
  owner: concise("负责人", 80),
  objective: concise("目标"),
  scope: lines("范围"),
  nonGoals: z.array(concise("非目标", 1_000)).max(30).default([]),
  acceptanceCriteria: lines("验收标准"),
});

export const developmentVersionSchema = z.object({
  projectVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "版本号格式不正确"),
  fromCommit: z.string().trim().regex(/^[a-f0-9]{7,64}$/i, "起始提交必须是 Git SHA"),
  toCommit: z.string().trim().regex(/^[a-f0-9]{7,64}$/i, "结束提交必须是 Git SHA"),
  diffContent: z.string().min(1, "必须保留 Diff 内容").max(200_000, "Diff 内容超过 200KB，请先存入制品库再提交受控摘要"),
  features: lines("功能", 80),
});

export const developmentFunctionalTestSchema = z.object({
  projectVersion: z.number().int().positive(),
  versionId: z.string().uuid(),
  name: concise("测试名称", 160),
  cases: lines("测试用例", 100),
  result: z.enum(["passed", "failed"]),
  evidence: concise("测试证据", 20_000),
});

export const developmentDeliverySchema = z.object({ projectVersion: z.number().int().positive() });
