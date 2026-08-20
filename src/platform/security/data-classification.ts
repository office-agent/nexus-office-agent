export const dataClassifications = ["public", "internal", "confidential", "restricted"] as const;
export type DataClassification = (typeof dataClassifications)[number];

const classificationRank: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const sensitivePatterns = [
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|bearer|authorization)\b\s*[:=：]\s*[^\s,;，；]{4,}/i,
  /\b(?:sk|rk|pk)_[a-z0-9_-]{12,}\b/i,
  /(?:密码|密钥|私钥|令牌|访问令牌|授权头)\s*[:：=]\s*[^\s,;，；]{4,}/i,
  /\b\d{17}[\dXx]\b/,
  /\b(?:\d[ -]*?){13,19}\b/,
  /(?:病历|诊断结果|治疗方案|医保记录|体检报告|心理咨询记录)/,
  /(?:薪酬明细|工资条|绩效考核|绩效评价|离职原因)/,
];

export function mostRestrictiveClassification(values: Iterable<DataClassification | undefined>, fallback: DataClassification = "internal"): DataClassification {
  let selected = fallback;
  for (const value of values) if (value && classificationRank[value] > classificationRank[selected]) selected = value;
  return selected;
}

export function classificationAtMost(value: DataClassification, maximum: DataClassification): boolean {
  return classificationRank[value] <= classificationRank[maximum];
}

export function hasSensitiveContent(value: string): boolean {
  // UUIDs are opaque object identifiers throughout the platform. They resemble a hyphenated
  // card number to a broad numeric detector but do not constitute sensitive content by themselves.
  const normalized = value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[uuid]");
  return sensitivePatterns.some((pattern) => pattern.test(normalized));
}

export function classifyUntrustedText(value: string, fallback: DataClassification = "internal"): DataClassification {
  return hasSensitiveContent(value) ? "restricted" : fallback;
}

export function classifyUntrustedValue(value: unknown, fallback: DataClassification = "internal", depth = 0): DataClassification {
  if (depth > 5 || value === null || value === undefined) return fallback;
  if (typeof value === "string") return classifyUntrustedText(value, fallback);
  if (Array.isArray(value)) return mostRestrictiveClassification(value.map((item) => classifyUntrustedValue(item, fallback, depth + 1)), fallback);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const declared = typeof record.classification === "string" && dataClassifications.includes(record.classification as DataClassification)
      ? record.classification as DataClassification
      : undefined;
    return mostRestrictiveClassification([declared, ...Object.values(record).map((item) => classifyUntrustedValue(item, fallback, depth + 1))], fallback);
  }
  return fallback;
}

export function redactedSensitivePlaceholder(): string {
  return "[该内容包含受限信息，正文未被发送给模型或写入对话与记忆存储。]";
}
