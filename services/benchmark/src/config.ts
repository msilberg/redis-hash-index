// The schema constants live with the fixture generator in packages/fixture; re-exported for this service.
export { CATEGORY, SERVICE, TENANT } from "@redis-hash-index/fixture";

// Every cache string and every index set is armed with this TTL — see docs/REDIS-SCHEMA.md.
export const CACHE_TTL_SECONDS = 3600;

// The marker key. Its presence means a completed seed survived a restart; `POST /api/seed/reset`
// flushes the db and clears it.
export const MARKER_KEY = "seed::marker";

export type SeedMode = "bulk" | "lazy";

export interface Config {
  port: number;
  redisUrl: string;
  seedKeys: number;
  seedValue: number;
  pipelineSize: number;
  // Seeding modes and the @Cache fill path (US-010).
  seedMode: SeedMode;
  lazyConcurrency: number;
  lazyMaxKeys: number;
  lazyWarmUsers: number;
  originLatencyMs: number;
  originFailUser: string | undefined;
  // Run driver (US-006). In compose the services address each other by container name.
  testApiBaseUrl: string;
  webhookBaseUrl: string;
  pollIntervalMs: number;
  batchDelayMs: number;
  batchUsers: number;
  pollTimeoutMs: number;
  runHistoryCap: number;
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

function seedModeFromEnv(raw: string | undefined): SeedMode {
  if (raw === undefined || raw === "") return "bulk";
  if (raw === "bulk" || raw === "lazy") return raw;
  throw new Error(`invalid SEED_MODE: ${JSON.stringify(raw)} (want bulk | lazy)`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: intFromEnv(env.PORT, 3000, "PORT", 1, 65535),
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    seedKeys: intFromEnv(env.SEED_KEYS, 2_000_000, "SEED_KEYS", 1, 1_000_000_000),
    seedValue: intFromEnv(env.SEED_VALUE, 1, "SEED_VALUE", 0, 0xffff_ffff),
    // Buffer ~20k commands; registerMany splits these into bounded pipelined transactions.
    pipelineSize: intFromEnv(env.SEED_PIPELINE_SIZE, 20_000, "SEED_PIPELINE_SIZE", 1, 5_000_000),
    // bulk pipelines the fixture; lazy fills every record through @Cache and is capped by LAZY_MAX_KEYS.
    seedMode: seedModeFromEnv(env.SEED_MODE),
    lazyConcurrency: intFromEnv(env.LAZY_CONCURRENCY, 16, "LAZY_CONCURRENCY", 1, 1024),
    lazyMaxKeys: intFromEnv(env.LAZY_MAX_KEYS, 50_000, "LAZY_MAX_KEYS", 1, 1_000_000_000),
    // Users 0..LAZY_WARM_USERS-1 — the eviction batch — are always filled through @Cache.
    lazyWarmUsers: intFromEnv(env.LAZY_WARM_USERS, 1000, "LAZY_WARM_USERS", 0, 10_000_000),
    originLatencyMs: intFromEnv(env.ORIGIN_LATENCY_MS, 0, "ORIGIN_LATENCY_MS", 0, 60_000),
    originFailUser: env.ORIGIN_FAIL_USER === "" ? undefined : env.ORIGIN_FAIL_USER,
    testApiBaseUrl: env.TEST_API_URL ?? "http://test-api:3001",
    webhookBaseUrl: env.WEBHOOK_URL ?? "http://webhook:3002",
    pollIntervalMs: intFromEnv(env.POLL_INTERVAL_MS, 1000, "POLL_INTERVAL_MS", 10, 3_600_000),
    batchDelayMs: intFromEnv(env.BATCH_DELAY_MS, 1000, "BATCH_DELAY_MS", 0, 3_600_000),
    batchUsers: intFromEnv(env.BATCH_USERS, 1000, "BATCH_USERS", 1, 10_000_000),
    // A poll that times out is data, not an error — keep it generous. See US-006.md.
    pollTimeoutMs: intFromEnv(env.POLL_TIMEOUT_MS, 30_000, "POLL_TIMEOUT_MS", 100, 600_000),
    runHistoryCap: intFromEnv(env.RUN_HISTORY_CAP, 3600, "RUN_HISTORY_CAP", 1, 1_000_000),
  };
}
