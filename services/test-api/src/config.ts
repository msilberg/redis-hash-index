export interface Config {
  port: number;
  redisUrl: string;
  // The origin behind GET /subscription (US-011): mock-billing, one network hop away.
  mockBillingUrl: string;
  billingTimeoutMs: number;
}

function intFromEnv(raw: string | undefined, fallback: number, name: string, min: number, max: number): number {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${name}: ${JSON.stringify(raw)} (want integer in ${min}..${max})`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: intFromEnv(env.PORT, 3001, "PORT", 1, 65535),
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    mockBillingUrl: env.MOCK_BILLING_URL ?? "http://mock-billing:3003",
    billingTimeoutMs: intFromEnv(env.BILLING_TIMEOUT_MS, 5000, "BILLING_TIMEOUT_MS", 1, 600_000),
  };
}
