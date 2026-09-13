// packages/cache — the read path: a read-through cache in front of a slow origin.
//
// `readThrough` is the implementation; `@Cached` is the same thing as a standard (TC39) method
// decorator, so a service method that talks to the origin gets cached without Redis appearing at
// the call site. That invisibility is what makes the composite key easy to build and hard to
// delete from — see docs/ARCHITECTURE.md, "read path".

import { AsyncLocalStorage } from "node:async_hooks";

import { assertValidTtl, type EntityIndex } from "./index";

/** The one command the read path adds. Writes go through `EntityIndex.registerMany`. */
export interface ReadThroughRedis {
  get(key: string): Promise<string | null>;
}

/** Any JSON-serialisable object. Interfaces qualify — no index signature required. */
export type CacheParams = object;

/** Where a read lives. `service` and `tenant` come from the {@link ReadThroughCache}. */
export interface ReadCoords {
  category: string;
  entityId: string;
  /** The variant. Serialised canonically (sorted keys) into the key's opaque tail. */
  params?: CacheParams;
}

export interface CachePolicy {
  ttlSeconds: number;
  /**
   * Cache an authoritative negative answer (the loader resolved `null`). Default false. A loader
   * that *throws* is never cached, whatever this says.
   */
  cacheNegative?: boolean;
  /** TTL for a cached negative. Required when `cacheNegative` is true. */
  negativeTtlSeconds?: number;
}

export interface ReadResult<T> {
  value: T;
  source: "cache" | "origin";
  cacheKey: string;
  /** Redis round trips only: the GET, plus the write when this call filled the cache. */
  redisMs: number;
  /** Time spent waiting on the origin (including joining another caller's flight). */
  originMs?: number;
  /** Whether a value was written — false for an uncached negative or a joined flight. */
  written: boolean;
}

export interface ReadThroughCacheOptions {
  service: string;
  tenant: string;
}

interface Flight {
  value: unknown;
  originMs: number;
  writeMs: number;
}

/**
 * Per-process read-through state for one service and tenant: the Redis reader, the index that
 * owns the write, and the single-flight table.
 */
export class ReadThroughCache {
  readonly service: string;
  readonly tenant: string;
  /** In-flight misses by cache key. Entries are removed in a `finally`, success or failure. */
  private readonly inFlight = new Map<string, Promise<Flight>>();

  constructor(
    private readonly redis: ReadThroughRedis,
    private readonly index: EntityIndex,
    options: ReadThroughCacheOptions,
  ) {
    this.service = options.service;
    this.tenant = options.tenant;
  }

  /**
   * `<service>::<tenant>::<category>::<entityId>::<canonical params>`. Throws unless the key
   * parses back to exactly these coordinates — the key grammar has one implementation, `parse`.
   */
  keyFor(coords: ReadCoords): string {
    const params = canonicalJson(coords.params ?? {});
    const cacheKey = [this.service, this.tenant, coords.category, coords.entityId, params].join("::");
    const parsed = this.index.parse(cacheKey);
    if (
      parsed === null ||
      parsed.service !== this.service ||
      parsed.tenant !== this.tenant ||
      parsed.entity !== coords.category ||
      parsed.entityId !== coords.entityId ||
      parsed.params !== params
    ) {
      throw new Error(`coordinates do not form a valid cache key: ${cacheKey}`);
    }
    return cacheKey;
  }

  /** In-flight misses, exposed for tests and diagnostics. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  // fly / write / read are the plumbing readThrough() drives; call readThrough, not these.

  /** Join the in-flight miss for `cacheKey`, or start one with `start`. */
  fly(cacheKey: string, start: () => Promise<Flight>): { flight: Promise<Flight>; leader: boolean } {
    const existing = this.inFlight.get(cacheKey);
    if (existing !== undefined) return { flight: existing, leader: false };
    const flight = start().finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, flight);
    return { flight, leader: true };
  }

  write(cacheKey: string, value: string, ttlSeconds: number): Promise<number> {
    return this.index.registerMany([{ cacheKey, value, ttlSeconds }]);
  }

  read(cacheKey: string): Promise<string | null> {
    return this.redis.get(cacheKey);
  }
}

/**
 * Read `coords` from the cache, or load it from the origin and write it through the index.
 *
 * 1. `GET` the canonical key. A hit returns without touching the origin.
 * 2. A miss calls `load` — once per key per process, however many callers miss concurrently.
 * 3. The value is written with `registerMany`, so `SET EX` and `SADD` share one transaction.
 *
 * A loader that throws propagates and writes nothing. A loader that resolves `null` is an
 * authoritative "no", cached only under `cacheNegative`. `undefined` is rejected: it cannot be
 * serialised, and silently treating it as "no" is how a swallowed error becomes a cached answer.
 */
export async function readThrough<T>(
  cache: ReadThroughCache,
  coords: ReadCoords,
  policy: CachePolicy,
  load: () => Promise<T>,
): Promise<ReadResult<T>> {
  const cacheKey = cache.keyFor(coords);
  const ttlSeconds = policy.ttlSeconds;
  const negativeTtlSeconds = policy.cacheNegative === true ? policy.negativeTtlSeconds : undefined;
  if (policy.cacheNegative === true && negativeTtlSeconds === undefined) {
    throw new Error("cacheNegative requires negativeTtlSeconds");
  }
  // Validate before the origin is called, not after: a bad policy must not cost an origin trip.
  assertValidTtl(ttlSeconds);
  if (negativeTtlSeconds !== undefined) assertValidTtl(negativeTtlSeconds);

  const readStarted = process.hrtime.bigint();
  const cached = await cache.read(cacheKey);
  const readMs = elapsedMs(readStarted);
  if (cached !== null) {
    const result: ReadResult<T> = {
      value: JSON.parse(cached) as T,
      source: "cache",
      cacheKey,
      redisMs: readMs,
      written: false,
    };
    report(result);
    return result;
  }

  const { flight, leader } = cache.fly(cacheKey, async () => {
    const originStarted = process.hrtime.bigint();
    const value = await load();
    const originMs = elapsedMs(originStarted);
    if (value === undefined) {
      throw new TypeError(`loader for ${cacheKey} resolved undefined; resolve null for "no such value"`);
    }
    const ttl = value === null ? negativeTtlSeconds : ttlSeconds;
    if (ttl === undefined) return { value, originMs, writeMs: 0 };
    const writeStarted = process.hrtime.bigint();
    await cache.write(cacheKey, JSON.stringify(value), ttl);
    return { value, originMs, writeMs: elapsedMs(writeStarted) };
  });

  const joinStarted = process.hrtime.bigint();
  const landed = await flight;
  const written = leader && (landed.value !== null || negativeTtlSeconds !== undefined);
  const result: ReadResult<T> = {
    value: landed.value as T,
    source: "origin",
    cacheKey,
    redisMs: readMs + (leader ? landed.writeMs : 0),
    originMs: leader ? landed.originMs : elapsedMs(joinStarted),
    written,
  };
  report(result);
  return result;
}

/** Options for {@link Cached}: where the entity lives, and how long to keep it. */
export interface CachedOptions extends CachePolicy {
  category: string;
}

/** A class using `@Cached` exposes its read-through cache as `cache`. */
export interface CachedHost {
  readonly cache: ReadThroughCache;
}

/**
 * Standard method decorator over {@link readThrough}. The decorated method takes the entity id and
 * an optional params object — together those are the cache key — and its body is the loader.
 *
 * ```ts
 * @Cached({ category: "activeSubscription", ttlSeconds: 3600 })
 * async getActiveSubscription(userId: string, params: { includeAddons: boolean }) { … }
 * ```
 *
 * The method still resolves the plain value. To see where it came from, wrap the call in
 * {@link captureReads}.
 */
export function Cached(options: CachedOptions) {
  const { category, ...policy } = options;
  return function <This extends CachedHost, P extends CacheParams, T>(
    target: (this: This, entityId: string, params: P) => Promise<T>,
    _context: ClassMethodDecoratorContext<This, (this: This, entityId: string, params: P) => Promise<T>>,
  ): (this: This, entityId: string, params: P) => Promise<T> {
    return async function (this: This, entityId: string, params: P): Promise<T> {
      const result = await readThrough(this.cache, { category, entityId, params }, policy, () =>
        target.call(this, entityId, params),
      );
      return result.value;
    };
  };
}

const readReports = new AsyncLocalStorage<Array<ReadResult<unknown>>>();

/**
 * Run `fn` and collect every read-through result it produced, in completion order. Scoped by
 * async context, so concurrent requests never see each other's reads.
 */
export async function captureReads<R>(
  fn: () => Promise<R>,
): Promise<{ value: R; reads: Array<ReadResult<unknown>> }> {
  const reads: Array<ReadResult<unknown>> = [];
  const value = await readReports.run(reads, fn);
  return { value, reads };
}

function report(result: ReadResult<unknown>): void {
  readReports.getStore()?.push(result);
}

/** `JSON.stringify` with object keys sorted at every depth, so equal params make equal keys. */
export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(sortKeys(value));
  if (json === undefined) throw new TypeError("params must be JSON-serialisable");
  return json;
}

function sortKeys(input: unknown): unknown {
  const value = hasToJson(input) ? input.toJSON() : input;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, sortKeys(source[key])]),
    );
  }
  return value;
}

function hasToJson(value: unknown): value is { toJSON(): unknown } {
  return value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function";
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}
