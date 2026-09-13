// The `@Cache` adapter: a standard TypeScript 5 method decorator over the cache strategies.
//
// Decorators evaluate when a class is defined, long before a Redis connection exists, so the
// strategies live in a small registry that each service fills once at bootstrap with
// `configureCache(...)` and that a decorated method resolves at CALL time. See tasks/US-010.md.

import { assertSegment, assertValidTtl, KEY_DELIMITER } from "./keys";
import type { RedisClient } from "./redis";
import { DefaultCacheStrategy } from "./strategies/default";
import { EntityIndexCacheStrategy } from "./strategies/entity-index";

/** Cache categories. Each value IS the `category` segment of the key schema (docs/REDIS-SCHEMA.md). */
export enum CacheKey {
  ACTIVE_SUBSCRIPTION = "activeSubscription",
  PLAN_CONFIG = "planConfig",
}

/** TTLs in whole seconds. `MEDIUM` is the fixture's 3600. */
export enum TTL {
  SHORT = 300,
  MEDIUM = 3600,
  LONG = 86_400,
}

export enum CacheStrategy {
  DEFAULT = "DEFAULT",
  ENTITY_INDEX_CACHE = "ENTITY_INDEX_CACHE",
}

export interface CacheConfig {
  redis: RedisClient;
  /** The `service` segment — who writes the record. */
  service: string;
  /** The `tenant` segment. */
  tenant: string;
  /** Categories the entity-index strategy owns; a key in any other category is a plain SET. */
  categories: Iterable<string>;
}

export interface CacheOptions {
  /** Cache a `null` result. Off by default: a cached "nothing" outlives the blip that caused it. */
  cacheNegative?: boolean;
  /** TTL for a cached `null`. Defaults to the decorator's positive TTL. */
  negativeTtl?: number;
}

interface CacheRegistry {
  service: string;
  tenant: string;
  strategies: Record<CacheStrategy, DefaultCacheStrategy>;
}

let registry: CacheRegistry | null = null;

/** Build one instance per strategy over the supplied client. Call once, in each service's bootstrap. */
export function configureCache(config: CacheConfig): void {
  assertSegment("service", config.service);
  assertSegment("tenant", config.tenant);
  registry = {
    service: config.service,
    tenant: config.tenant,
    strategies: {
      [CacheStrategy.DEFAULT]: new DefaultCacheStrategy(config.redis),
      [CacheStrategy.ENTITY_INDEX_CACHE]: new EntityIndexCacheStrategy(config.redis, {
        categories: config.categories,
      }),
    },
  };
}

/** The configured strategy instance. Throws if `configureCache` has not run. */
export function getCacheStrategy(strategy: CacheStrategy): DefaultCacheStrategy {
  return requireRegistry("getCacheStrategy").strategies[strategy];
}

/** Drop the registry. For tests that exercise the unconfigured path. */
export function resetCacheConfiguration(): void {
  registry = null;
}

function requireRegistry(caller: string): CacheRegistry {
  if (registry === null) {
    throw new Error(
      `${caller}: the cache is not configured — call configureCache({ redis, service, tenant, categories }) at service bootstrap`,
    );
  }
  return registry;
}

/**
 * JSON with object keys sorted at every depth, so `{a:1,b:2}` and `{b:2,a:1}` serialise identically.
 * `undefined` object members are dropped, as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}

/**
 * `service::tenant::category::entityId::params`. The entity ID is the first argument; `params` is the
 * canonical JSON of the second argument (or `{}` when absent), or of the whole tail when there are
 * several. An entity ID outside the segment character class throws — it is never escaped.
 */
export function buildCacheKey(
  service: string,
  tenant: string,
  category: string,
  args: readonly unknown[],
): string {
  const [entityId, ...rest] = args;
  if (typeof entityId !== "string") {
    throw new TypeError(`@Cache: the first argument must be the entity ID string, got ${typeof entityId}`);
  }
  assertSegment("entityId", entityId);
  const params = rest.length <= 1 ? canonicalJson(rest[0] ?? {}) : canonicalJson(rest);
  return [service, tenant, category, entityId, params].join(KEY_DELIMITER);
}

type AsyncMethod<This, Args extends unknown[], Result> = (this: This, ...args: Args) => Promise<Result>;

/**
 * Cache an async method's result. On a hit the method is not called. On a miss the result is written
 * through the strategy's `set`. Concurrent misses for one key in this process share one call.
 *
 * A rejection is never cached and writes nothing. `undefined` is never cached. `null` is cached only
 * with `{ cacheNegative: true }`.
 */
export function Cache(cacheKey: CacheKey, ttl: TTL | number, strategy: CacheStrategy, options: CacheOptions = {}) {
  assertValidTtl(ttl);
  const negativeTtl = options.negativeTtl ?? ttl;
  if (options.cacheNegative === true) assertValidTtl(negativeTtl);

  return function <This, Args extends [string, ...unknown[]], Result>(
    target: AsyncMethod<This, Args, Result>,
    context: ClassMethodDecoratorContext<This, AsyncMethod<This, Args, Result>>,
  ): AsyncMethod<This, Args, Result> {
    const methodName = String(context.name);
    // Single-flight: one in-flight load per key, per decorated method, in this process.
    const inFlight = new Map<string, Promise<Result>>();

    // `async` with no `await` on purpose: an unconfigured cache or a bad entity ID throws synchronously
    // below, and callers expect a rejected promise, not an exception from the call expression.
    return async function (this: This, ...args: Args): Promise<Result> {
      const { service, tenant, strategies } = requireRegistry(`@Cache on ${methodName}()`);
      const key = buildCacheKey(service, tenant, cacheKey, args);
      const store = strategies[strategy];

      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;

      const load = (async (): Promise<Result> => {
        const cached = await store.get(key);
        if (cached !== null) return JSON.parse(cached) as Result;

        // No try/catch here on purpose: a rejection must propagate and write nothing.
        const result = await target.apply(this, args);
        if (result === undefined) return result;
        if (result === null) {
          if (options.cacheNegative === true) await store.set(key, "null", negativeTtl);
          return result;
        }
        await store.set(key, JSON.stringify(result), ttl);
        return result;
      })().finally(() => {
        inFlight.delete(key);
      });

      // Registered synchronously, before `load` can settle, so a concurrent miss joins it. The cleanup
      // is chained onto the promise: returning `load` from inside a try/finally would run the finally
      // at once and end single-flight before the load had even started.
      inFlight.set(key, load);
      return load;
    };
  };
}
