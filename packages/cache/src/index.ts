// packages/cache — the shared cache strategies and the `@Cache` decorator over them.
//
// See docs/REDIS-SCHEMA.md for the key contract and docs/ARCHITECTURE.md ("Cache strategies").

export type { RedisClient, RedisMulti, RedisPipeline } from "./redis";
export { INDEX_PREFIX } from "./keys";
export { DefaultCacheStrategy, type DefaultCacheStrategyOptions } from "./strategies/default";
export {
  EntityIndexCacheStrategy,
  type EntityFailure,
  type EntityIndexCacheStrategyOptions,
  type InvalidationResult,
  type ParsedCacheKey,
  type PruneResult,
  type Registration,
} from "./strategies/entity-index";
export {
  buildCacheKey,
  Cache,
  CacheKey,
  CacheStrategy,
  canonicalJson,
  configureCache,
  getCacheStrategy,
  resetCacheConfiguration,
  TTL,
  type CacheConfig,
  type CacheOptions,
} from "./cache-decorator";
