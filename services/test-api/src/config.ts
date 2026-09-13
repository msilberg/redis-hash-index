export interface Config {
  port: number;
  redisUrl: string;
  // The fake billing origin behind GET /subscription (US-009). SEED_VALUE must match the benchmark's
  // or a filled record differs from the seeded one.
  seedValue: number;
  originLatencyMs: number;
  originFailUser: string | undefined;
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
    seedValue: intFromEnv(env.SEED_VALUE, 1, "SEED_VALUE", 0, 0xffff_ffff),
    originLatencyMs: intFromEnv(env.ORIGIN_LATENCY_MS, 0, "ORIGIN_LATENCY_MS", 0, 60_000),
    originFailUser: env.ORIGIN_FAIL_USER === undefined || env.ORIGIN_FAIL_USER === "" ? undefined : env.ORIGIN_FAIL_USER,
  };
}
