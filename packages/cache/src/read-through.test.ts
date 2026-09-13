import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import Redis from "ioredis";

import {
  Cached,
  EntityIndex,
  ReadThroughCache,
  canonicalJson,
  captureReads,
  readThrough,
  type RedisClient,
} from "./index";

// Real Redis, like index.test.ts — but DB 14: node:test runs test files in parallel processes and
// both files flushdb between cases.
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const TEST_DB = 14;

const SERVICE = "test-api";
const TENANT = "demo";
const CATEGORY = "activeSubscription";
const USER = "u_0000042";
const POLICY = { ttlSeconds: 3600 };

let redis: Redis;
let index: EntityIndex;
let cache: ReadThroughCache;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A promise with its resolve/reject handles — lets a test hold the origin open mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

before(async () => {
  redis = new Redis(REDIS_URL, { db: TEST_DB, maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();
  index = new EntityIndex(redis as unknown as RedisClient, { categories: [CATEGORY] });
});

after(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushdb();
  cache = new ReadThroughCache(redis, index, { service: SERVICE, tenant: TENANT });
});

const indexKey = (): string => index.indexKeyFor(TENANT, CATEGORY, USER);

describe("cache key", () => {
  it("round-trips through parse unchanged", () => {
    const params = { includeAddons: true, region: "eu" };
    const key = cache.keyFor({ category: CATEGORY, entityId: USER, params });
    assert.deepEqual(index.parse(key), {
      service: SERVICE,
      tenant: TENANT,
      entity: CATEGORY,
      entityId: USER,
      params: canonicalJson(params),
      indexKey: indexKey(),
    });
  });

  it("is canonical: parameter order does not change the key, at any depth", () => {
    const a = cache.keyFor({ category: CATEGORY, entityId: USER, params: { a: 1, b: { y: 2, x: 1 } } });
    const b = cache.keyFor({ category: CATEGORY, entityId: USER, params: { b: { x: 1, y: 2 }, a: 1 } });
    assert.equal(a, b);
    assert.equal(a, `${SERVICE}::${TENANT}::${CATEGORY}::${USER}::{"a":1,"b":{"x":1,"y":2}}`);
  });

  it("rejects coordinates that would not parse back", () => {
    assert.throws(() => cache.keyFor({ category: CATEGORY, entityId: `${USER}::evil` }));
    assert.throws(() => cache.keyFor({ category: "unknownCategory", entityId: USER }));
  });
});

describe("readThrough", () => {
  it("a miss loads and writes value + reference; a hit never touches the origin", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return { planId: "pro-monthly" };
    };
    const coords = { category: CATEGORY, entityId: USER, params: { v: 1 } };

    const first = await readThrough(cache, coords, POLICY, load);
    assert.equal(first.source, "origin");
    assert.equal(first.written, true);
    assert.equal(typeof first.originMs, "number");
    assert.equal(await redis.get(first.cacheKey), '{"planId":"pro-monthly"}');
    assert.deepEqual(await redis.smembers(indexKey()), [first.cacheKey]);
    assert.ok((await redis.ttl(first.cacheKey)) > 3590);
    assert.ok((await redis.ttl(indexKey())) > 3590);

    const second = await readThrough(cache, coords, POLICY, load);
    assert.equal(second.source, "cache");
    assert.equal(second.originMs, undefined);
    assert.deepEqual(second.value, { planId: "pro-monthly" });
    assert.equal(calls, 1);
  });

  it("an origin error propagates, writes nothing, and the next call still reaches the origin", async () => {
    let calls = 0;
    const failing = async (): Promise<{ planId: string }> => {
      calls += 1;
      throw new Error("billing provider timed out");
    };
    const coords = { category: CATEGORY, entityId: USER };
    const policy = { ttlSeconds: 3600, cacheNegative: true, negativeTtlSeconds: 60 };

    await assert.rejects(readThrough(cache, coords, policy, failing), /billing provider timed out/);
    assert.equal(await redis.dbsize(), 0, "no value and no index member");
    assert.equal(cache.inFlightCount, 0, "the failed flight is cleared");

    await assert.rejects(readThrough(cache, coords, policy, failing));
    assert.equal(calls, 2, "the error was not cached");
    assert.equal(await redis.dbsize(), 0);
  });

  it("an authoritative negative is not cached by default", async () => {
    let calls = 0;
    const none = async () => {
      calls += 1;
      return null;
    };
    const coords = { category: CATEGORY, entityId: USER };
    const first = await readThrough(cache, coords, POLICY, none);
    assert.equal(first.value, null);
    assert.equal(first.written, false);
    assert.equal(await redis.dbsize(), 0);
    await readThrough(cache, coords, POLICY, none);
    assert.equal(calls, 2);
  });

  it("cacheNegative caches null under its own TTL", async () => {
    let calls = 0;
    const none = async () => {
      calls += 1;
      return null;
    };
    const coords = { category: CATEGORY, entityId: USER };
    const policy = { ttlSeconds: 3600, cacheNegative: true, negativeTtlSeconds: 60 };

    const first = await readThrough(cache, coords, policy, none);
    assert.equal(first.written, true);
    const ttl = await redis.ttl(first.cacheKey);
    assert.ok(ttl > 50 && ttl <= 60, `expected ~60, got ${ttl}`);

    const second = await readThrough(cache, coords, policy, none);
    assert.equal(second.source, "cache");
    assert.equal(second.value, null);
    assert.equal(calls, 1);
  });

  it("rejects a loader resolving undefined and writes nothing", async () => {
    const coords = { category: CATEGORY, entityId: USER };
    await assert.rejects(readThrough(cache, coords, POLICY, async () => undefined), TypeError);
    assert.equal(await redis.dbsize(), 0);
  });

  it("validates the policy before calling the origin", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return 1;
    };
    const coords = { category: CATEGORY, entityId: USER };
    await assert.rejects(readThrough(cache, coords, { ttlSeconds: 0 }, load), RangeError);
    await assert.rejects(readThrough(cache, coords, { ttlSeconds: 60, cacheNegative: true }, load));
    assert.equal(calls, 0);
  });

  it("single-flight: 50 concurrent misses for one key make exactly one loader call", async () => {
    let calls = 0;
    const origin = deferred<{ planId: string }>();
    const load = () => {
      calls += 1;
      return origin.promise;
    };
    const coords = { category: CATEGORY, entityId: USER, params: { includeAddons: true } };

    const reads = Array.from({ length: 50 }, () => readThrough(cache, coords, POLICY, load));
    await delay(50); // let every caller's GET miss and join the flight
    origin.resolve({ planId: "team-monthly" });
    const results = await Promise.all(reads);

    assert.equal(calls, 1);
    assert.equal(results.filter((r) => r.written).length, 1, "only the leader writes");
    assert.ok(results.every((r) => r.source === "origin" && r.value.planId === "team-monthly"));
    assert.equal(cache.inFlightCount, 0);
    assert.deepEqual(await redis.smembers(indexKey()), [results[0]?.cacheKey]);
  });
});

describe("fill versus invalidation", () => {
  const coords = { category: CATEGORY, entityId: USER, params: { includeAddons: false } };

  it("an invalidation mid-fill removes what existed; the fill lands consistent and survives to its TTL", async () => {
    // An older variant already cached for this user.
    const older = await readThrough(cache, { ...coords, params: { includeAddons: true } }, POLICY, async () => ({
      planId: "pro-monthly",
    }));
    assert.equal(await redis.exists(older.cacheKey), 1);

    // Begin a fill against a slow origin and hold it open.
    const origin = deferred<{ planId: string }>();
    const ttlSeconds = 2;
    const filling = readThrough(cache, coords, { ttlSeconds }, () => origin.promise);
    await delay(20);

    // The invalidation lands while the fill is in flight.
    const invalidated = await index.invalidateEntities(TENANT, CATEGORY, [USER]);
    assert.deepEqual(invalidated.incomplete, []);
    assert.equal(invalidated.valuesUnlinked, 1);
    assert.equal(await redis.exists(older.cacheKey), 0, "what existed at invalidation time is gone");
    assert.equal(await redis.exists(indexKey()), 0);

    // The origin answers with what it read before the invalidation. The fill writes it anyway.
    origin.resolve({ planId: "pre-invalidation" });
    const filled = await filling;
    assert.equal(filled.written, true);

    // Value and reference agree: no orphan value, no dangling reference.
    assert.equal(await redis.get(filled.cacheKey), '{"planId":"pre-invalidation"}');
    assert.deepEqual(await redis.smembers(indexKey()), [filled.cacheKey]);
    const valueTtl = await redis.pttl(filled.cacheKey);
    const indexTtl = await redis.pttl(indexKey());
    assert.ok(valueTtl > 0 && valueTtl <= ttlSeconds * 1000, `value TTL ${valueTtl}`);
    assert.ok(indexTtl > 0 && indexTtl <= ttlSeconds * 1000, `index TTL ${indexTtl}`);

    // Bounded staleness: the stale value is served from cache until its TTL, and no longer.
    const stale = await readThrough(cache, coords, { ttlSeconds }, async () => ({ planId: "fresh" }));
    assert.equal(stale.source, "cache");
    assert.deepEqual(stale.value, { planId: "pre-invalidation" });

    await delay(ttlSeconds * 1000 + 100);
    assert.equal(await redis.exists(filled.cacheKey), 0, "the stale value expired with its TTL");
    assert.equal(await redis.exists(indexKey()), 0, "and so did its reference");
    const fresh = await readThrough(cache, coords, { ttlSeconds }, async () => ({ planId: "fresh" }));
    assert.equal(fresh.source, "origin");
    assert.deepEqual(fresh.value, { planId: "fresh" });
  });

  it("an invalidation after the fill completes removes both value and reference", async () => {
    const filled = await readThrough(cache, coords, POLICY, async () => ({ planId: "pro-yearly" }));
    assert.equal(await redis.exists(filled.cacheKey), 1);

    const invalidated = await index.invalidateEntities(TENANT, CATEGORY, [USER]);
    assert.equal(invalidated.valuesUnlinked, 1);
    assert.equal(invalidated.referencesRemoved, 1);
    assert.equal(await redis.exists(filled.cacheKey), 0);
    assert.equal(await redis.exists(indexKey()), 0);

    const next = await readThrough(cache, coords, POLICY, async () => ({ planId: "pro-yearly" }));
    assert.equal(next.source, "origin");
  });
});

describe("@Cached", () => {
  class SubscriptionReader {
    calls = 0;
    constructor(readonly cache: ReadThroughCache) {}

    @Cached({ category: CATEGORY, ttlSeconds: 3600 })
    async getActiveSubscription(userId: string, params: { includeAddons: boolean }): Promise<{ userId: string; addons: boolean } | null> {
      this.calls += 1;
      await delay(5);
      return { userId, addons: params.includeAddons };
    }
  }

  it("caches the decorated method by entity id and params, and reports each read's source", async () => {
    const reader = new SubscriptionReader(cache);

    const first = await captureReads(() => reader.getActiveSubscription(USER, { includeAddons: true }));
    assert.deepEqual(first.value, { userId: USER, addons: true });
    assert.equal(first.reads.length, 1);
    assert.equal(first.reads[0]?.source, "origin");

    const second = await captureReads(() => reader.getActiveSubscription(USER, { includeAddons: true }));
    assert.equal(second.reads[0]?.source, "cache");
    assert.deepEqual(second.value, { userId: USER, addons: true });

    await reader.getActiveSubscription(USER, { includeAddons: false });
    assert.equal(reader.calls, 2, "a different params object is a different key");
    assert.equal((await redis.smembers(indexKey())).length, 2);
  });

  it("keeps concurrent captures separate", async () => {
    const reader = new SubscriptionReader(cache);
    const [a, b] = await Promise.all([
      captureReads(() => reader.getActiveSubscription("u_0000001", { includeAddons: false })),
      captureReads(() => reader.getActiveSubscription("u_0000002", { includeAddons: false })),
    ]);
    assert.equal(a.reads.length, 1);
    assert.equal(b.reads.length, 1);
    assert.match(a.reads[0]?.cacheKey ?? "", /u_0000001/);
    assert.match(b.reads[0]?.cacheKey ?? "", /u_0000002/);
  });
});
