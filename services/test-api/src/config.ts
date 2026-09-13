// Static pieces of the Redis schema this service is pinned to. `demo` is the only tenant and
// `activeSubscription` the only indexed category — see docs/REDIS-SCHEMA.md.
export const SERVICE = "test-api";
export const TENANT = "demo";
export const CATEGORY = "activeSubscription";

export interface Config {
  port: number;
  redisUrl: string;
  originLatencyMs: number;
  originFailUser?: string;
  seedValue: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? "3001");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PORT: ${JSON.stringify(env.PORT)}`);
  }
  const originLatencyMs = Number(env.ORIGIN_LATENCY_MS ?? "150");
  if (!Number.isInteger(originLatencyMs) || originLatencyMs < 0 || originLatencyMs > 60_000) {
    throw new Error(`invalid ORIGIN_LATENCY_MS (0..60000): ${JSON.stringify(env.ORIGIN_LATENCY_MS)}`);
  }
  const seedValue = Number(env.SEED_VALUE ?? "1");
  if (!Number.isInteger(seedValue) || seedValue < 0 || seedValue > 0xffff_ffff) {
    throw new Error(`invalid SEED_VALUE: ${JSON.stringify(env.SEED_VALUE)}`);
  }
  const originFailUser = env.ORIGIN_FAIL_USER === undefined || env.ORIGIN_FAIL_USER === "" ? {} : { originFailUser: env.ORIGIN_FAIL_USER };
  return {
    port,
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    originLatencyMs,
    seedValue,
    ...originFailUser,
  };
}
