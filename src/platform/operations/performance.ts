export type LatencySummary = { samples: number; p50Ms: number; p95Ms: number; maxMs: number };

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function summarizeLatencies(values: number[]): LatencySummary {
  return { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: values.length ? Math.max(...values) : 0 };
}

export async function benchmarkOperation(iterations: number, operation: () => Promise<unknown>): Promise<LatencySummary> {
  const values: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await operation();
    values.push(performance.now() - started);
  }
  return summarizeLatencies(values);
}
