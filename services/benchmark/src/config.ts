// Static pieces of the Redis schema this service is pinned to. `demo` is the only tenant and
// `activeSubscription` the only indexed category — see docs/REDIS-SCHEMA.md.
export const TENANT = "demo";
export const CATEGORY = "activeSubscription";

// The `service` segment of a cache key names *who wrote the record*. In this demo that is always
// `test-api` (the reader owns the record shape); the benchmark only seeds on its behalf.
export const SERVICE = "test-api";

// Every cache string and every index set is armed with this TTL — see docs/REDIS-SCHEMA.md.
export const CACHE_TTL_SECONDS = 3600;

// Plan ids are cycled deterministically over this list, one step per cache record.
export const PLAN_IDS = ["pro-monthly", "pro-yearly", "team-monthly", "gen-ai-100k"] as const;

// SEED_KEYS is a count of cache *records*; user count is derived so users * averageVariants ≈ SEED_KEYS.
export const AVERAGE_VARIANTS = 2;

// The marker key. Its presence means a completed seed survived a restart; `POST /api/seed/reset`
// flushes the db and clears it.
export const MARKER_KEY = "seed::marker";

export interface Config {
  port: number;
  redisUrl: string;
  seedKeys: number;
  seedValue: number;
  pipelineSize: number;
}

function intFromEnv(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${name}: ${JSON.stringify(raw)} (want integer in ${min}..${max})`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: intFromEnv(env.PORT, 3000, "PORT", 1, 65535),
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    seedKeys: intFromEnv(env.SEED_KEYS, 2_000_000, "SEED_KEYS", 1, 1_000_000_000),
    seedValue: intFromEnv(env.SEED_VALUE, 1, "SEED_VALUE", 0, 0xffff_ffff),
    // ~20k commands per pipeline keeps memory bounded while staying well under Redis's limits.
    pipelineSize: intFromEnv(env.SEED_PIPELINE_SIZE, 20_000, "SEED_PIPELINE_SIZE", 1, 5_000_000),
  };
}
