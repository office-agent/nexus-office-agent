type MetricLabels = Record<string, string>;
type Counter = { name: string; labels: MetricLabels; value: number };
type Histogram = { name: string; labels: MetricLabels; count: number; sum: number; max: number };

const runtime = globalThis as typeof globalThis & {
  __nexusCounters?: Map<string, Counter>;
  __nexusHistograms?: Map<string, Histogram>;
};

const sensitiveKey = /(authorization|cookie|secret|token|password|credential|prompt|message|content)/i;

function normalizedLabels(labels: MetricLabels): MetricLabels {
  return Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, value.slice(0, 80)]));
}

function metricKey(name: string, labels: MetricLabels): string {
  return `${name}:${JSON.stringify(normalizedLabels(labels))}`;
}

function counters(): Map<string, Counter> { return runtime.__nexusCounters ??= new Map(); }
function histograms(): Map<string, Histogram> { return runtime.__nexusHistograms ??= new Map(); }

export function incrementCounter(name: string, labels: MetricLabels = {}, amount = 1): void {
  const safeLabels = normalizedLabels(labels);
  const key = metricKey(name, safeLabels);
  const existing = counters().get(key);
  if (existing) existing.value += amount;
  else counters().set(key, { name, labels: safeLabels, value: amount });
}

export function observeDuration(name: string, milliseconds: number, labels: MetricLabels = {}): void {
  const safeLabels = normalizedLabels(labels);
  const key = metricKey(name, safeLabels);
  const existing = histograms().get(key);
  if (existing) {
    existing.count += 1; existing.sum += milliseconds; existing.max = Math.max(existing.max, milliseconds);
  } else histograms().set(key, { name, labels: safeLabels, count: 1, sum: milliseconds, max: milliseconds });
}

export async function measureOperation<T>(name: string, labels: MetricLabels, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await work();
    incrementCounter(`${name}.total`, { ...labels, outcome: "success" });
    return result;
  } catch (error) {
    incrementCounter(`${name}.total`, { ...labels, outcome: "failure" });
    throw error;
  } finally {
    observeDuration(`${name}.duration_ms`, performance.now() - started, labels);
  }
}

export function telemetrySnapshot() {
  return { counters: [...counters().values()].map((value) => ({ ...value, labels: { ...value.labels } })), histograms: [...histograms().values()].map((value) => ({ ...value, labels: { ...value.labels } })) };
}

export function redactOperationalFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : typeof value === "string" ? value.slice(0, 500) : value]));
}

export function logOperationalEvent(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...redactOperationalFields(fields) });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.info(entry);
}

export const SLO_TARGETS = {
  apiAvailability: 0.999,
  readP95Ms: 500,
  writeP95Ms: 800,
  webhookAckP95Ms: 500,
  agentFirstTokenP95Ms: 4_000,
  eventualConsistencySeconds: 60,
  rpoMinutes: 15,
  rtoMinutes: 120,
  auditCompleteness: 1,
} as const;
