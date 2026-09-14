// Static pieces of the Redis schema the fixture is pinned to. `demo` is the only tenant and
// `activeSubscription` the only indexed category — see docs/REDIS-SCHEMA.md.
export const TENANT = "demo";
export const CATEGORY = "activeSubscription";

// The `service` segment of a cache key names *who wrote the record*. In this demo that is always
// `test-api` (the reader owns the record shape); the benchmark only seeds on its behalf.
export const SERVICE = "test-api";

// Plan ids are cycled deterministically over this list, one step per cache record.
export const PLAN_IDS = ["pro-monthly", "pro-yearly", "team-monthly", "gen-ai-100k"] as const;

// SEED_KEYS is a count of cache *records*; user count is derived so users * averageVariants ≈ SEED_KEYS.
export const AVERAGE_VARIANTS = 2;

/** The internal record: what a cache value decodes to. Serialise it only with `serializeSubscription`. */
export interface Subscription {
  userId: string;
  planId: string;
  status: string;
  renewsAt: string;
  seats: number;
}
