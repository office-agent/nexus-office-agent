export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number };

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function consumeLocalAuthRateLimit(key: string, now = Date.now(), limit = 30, windowMs = 60_000): RateLimitResult {
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > 10_000) {
    for (const [candidate, value] of buckets) if (value.resetAt <= now) buckets.delete(candidate);
  }
  return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
}

export function getSecurityHeaders(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  // Next.js development React uses eval() to reconstruct useful browser-side
  // error stacks. Keep that relaxation scoped to development; production
  // responses remain on the strict no-eval policy.
  const developmentScriptSource = env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const lanHttp = env.NEXUS_DEPLOYMENT_MODE === "lan" && !env.PUBLIC_APP_ORIGIN?.startsWith("https://");
  const upgradeInsecureRequests = lanHttp ? "" : " upgrade-insecure-requests";
  return {
    "content-security-policy": `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'${developmentScriptSource}; connect-src 'self' https:;${upgradeInsecureRequests}`,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = getSecurityHeaders();
