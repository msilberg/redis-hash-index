import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import Redis from "ioredis";

import {
  buildCacheKey,
  Cache,
  CacheKey,
  CacheStrategy,
  canonicalJson,
  configureCache,
  DefaultCacheStrategy,
  EntityIndexCacheStrategy,
  INDEX_PREFIX,
  resetCacheConfiguration,
  TTL,
  type RedisClient,
} from "./index";

// Real Redis, DB 14: index.test.ts owns DB 15 and node:test runs the two files in parallel.
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const TEST_DB = 14;

const SERVICE = "test-api";
const TENANT = "demo";
const CATEGORY = CacheKey.ACTIVE_SUBSCRIPTION;
const USER = "u_0000042";
const INDEX_KEY = `${INDEX_PREFIX}::${TENANT}::${CATEGORY}::${USER}`;

let redis: Redis;
const client = (): RedisClient => redis as unknown as RedisClient;

/** Wraps the client and records every top-level command name, so a test can see which path ran. */
function recording(): { client: RedisClient; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(redis, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { client: proxy as unknown as RedisClient, calls };
}

const configure = (redisClient: RedisClient = client()): void => {
  configureCache({ redis: redisClient, service: SERVICE, tenant: TENANT, categories: [CATEGORY] });
};

interface Subscription {
  userId: string;
  planId: string;
}

/** A fake origin whose behaviour each test scripts, counting how often it is reached. */
class Origin {
  calls = 0;
  delayMs = 0;
  next: (userId: string) => Subscription | null | undefined = (userId) => ({ userId, planId: "pro-monthly" });

  async fetch(userId: string): Promise<Subscription | null | undefined> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.next(userId);
  }
}

class SubscriptionService {
  constructor(readonly origin: Origin) {}

  @Cache(CacheKey.ACTIVE_SUBSCRIPTION, TTL.MEDIUM, CacheStrategy.ENTITY_INDEX_CACHE)
  getActiveSubscription(userId: string, _params: Record<string, unknown> = {}): Promise<Subscription | null | undefined> {
    return this.origin.fetch(userId);
  }

  @Cache(CacheKey.ACTIVE_SUBSCRIPTION, TTL.SHORT, CacheStrategy.ENTITY_INDEX_CACHE, { cacheNegative: true, negativeTtl: 60 })
  getWithNegative(userId: string): Promise<Subscription | null | undefined> {
    return this.origin.fetch(userId);
  }

  @Cache(CacheKey.PLAN_CONFIG, TTL.LONG, CacheStrategy.DEFAULT)
  async getPlanConfig(planId: string): Promise<{ planId: string }> {
    this.origin.calls += 1;
    return { planId };
  }
}

const keyFor = (params = "{}"): string => `${SERVICE}::${TENANT}::${CATEGORY}::${USER}::${params}`;

before(async () => {
  redis = new Redis(REDIS_URL, { db: TEST_DB, maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();
});

after(async () => {
  resetCacheConfiguration();
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushdb();
  configure();
});

describe("DefaultCacheStrategy", () => {
  it("get is a plain GET and set is SET EX", async () => {
    const strategy = new DefaultCacheStrategy(client());
    assert.equal(await strategy.get("plain"), null);
    await strategy.set("plain", "v", 120);
    assert.equal(await strategy.get("plain"), "v");
    const ttl = await redis.ttl("plain");
    assert.ok(ttl > 0 && ttl <= 120, `ttl ${ttl}`);
  });

  it("rejects an invalid TTL before issuing any command", async () => {
    const { client: rec, calls } = recording();
    const strategy = new DefaultCacheStrategy(rec);
    for (const bad of [0, -1, 1.5, 2_592_001, Number.NaN]) {
      await assert.rejects(strategy.set("plain", "v", bad), RangeError);
    }
    assert.deepEqual(calls, []);
    assert.equal(await redis.exists("plain"), 0);
  });
});

describe("EntityIndexCacheStrategy.set", () => {
  it("is a DefaultCacheStrategy", () => {
    assert.ok(new EntityIndexCacheStrategy(client(), { categories: [CATEGORY] }) instanceof DefaultCacheStrategy);
  });

  it("writes the value and its index reference in one MULTI, never a separate SET", async () => {
    const { client: rec, calls } = recording();
    const strategy = new EntityIndexCacheStrategy(rec, { categories: [CATEGORY] });
    await strategy.set(keyFor('{"v":1}'), "value", 3600);

    assert.deepEqual(calls, ["multi"]);
    assert.equal(await redis.get(keyFor('{"v":1}')), "value");
    assert.deepEqual(await redis.smembers(INDEX_KEY), [keyFor('{"v":1}')]);
    const indexTtl = await redis.ttl(INDEX_KEY);
    assert.ok(indexTtl > 0 && indexTtl <= 3600, `index ttl ${indexTtl}`);
  });

  it("falls back to a plain SET for a category it does not own", async () => {
    const { client: rec, calls } = recording();
    const strategy = new EntityIndexCacheStrategy(rec, { categories: [CATEGORY] });
    const foreign = `${SERVICE}::${TENANT}::${CacheKey.PLAN_CONFIG}::pro-monthly::{}`;
    await strategy.set(foreign, "plan", 300);

    assert.deepEqual(calls, ["set"]);
    assert.equal(await redis.get(foreign), "plan");
    assert.equal(await redis.dbsize(), 1);
  });

  it("rejects an invalid TTL on the indexed path without writing", async () => {
    const strategy = new EntityIndexCacheStrategy(client(), { categories: [CATEGORY] });
    await assert.rejects(strategy.set(keyFor(), "value", 0), RangeError);
    assert.equal(await redis.dbsize(), 0);
  });
});

describe("enums", () => {
  it("CacheKey values are category segments, TTL.MEDIUM is the fixture TTL", () => {
    assert.equal(CacheKey.ACTIVE_SUBSCRIPTION, "activeSubscription");
    assert.equal(TTL.MEDIUM, 3600);
    assert.deepEqual(Object.values(CacheStrategy), ["DEFAULT", "ENTITY_INDEX_CACHE"]);
  });
});

describe("key building", () => {
  it("canonical params: key order does not change the key", () => {
    assert.equal(canonicalJson({ b: 2, a: { d: 1, c: [{ z: 1, y: 2 }] } }), '{"a":{"c":[{"y":2,"z":1}],"d":1},"b":2}');
    assert.equal(
      buildCacheKey(SERVICE, TENANT, CATEGORY, [USER, { a: 1, b: 2 }]),
      buildCacheKey(SERVICE, TENANT, CATEGORY, [USER, { b: 2, a: 1 }]),
    );
    assert.equal(buildCacheKey(SERVICE, TENANT, CATEGORY, [USER]), keyFor("{}"));
    assert.equal(buildCacheKey(SERVICE, TENANT, CATEGORY, [USER, { v: 2 }]), keyFor('{"v":2}'));
  });

  it("a built key round-trips through parse() unchanged", () => {
    const strategy = new EntityIndexCacheStrategy(client(), { categories: [CATEGORY] });
    for (const args of [[USER], [USER, { v: 3 }], [USER, { includeAddons: true, region: "eu::west" }]]) {
      const key = buildCacheKey(SERVICE, TENANT, CATEGORY, args);
      const parsed = strategy.parse(key);
      assert.ok(parsed, `parse(${key}) returned null`);
      assert.equal([parsed.service, parsed.tenant, parsed.entity, parsed.entityId, parsed.params].join("::"), key);
      assert.equal(parsed.indexKey, INDEX_KEY);
    }
  });

  it("an entity ID outside the segment class throws instead of being escaped", async () => {
    const origin = new Origin();
    const service = new SubscriptionService(origin);
    await assert.rejects(service.getActiveSubscription("u_1::evil"), /invalid entityId segment/);
    assert.equal(origin.calls, 0);
    assert.equal(await redis.dbsize(), 0);
  });
});

describe("@Cache", () => {
  it("throws a clear error before configureCache and never calls the method", async () => {
    resetCacheConfiguration();
    const origin = new Origin();
    await assert.rejects(
      new SubscriptionService(origin).getActiveSubscription(USER),
      /@Cache on getActiveSubscription\(\): the cache is not configured — call configureCache/,
    );
    assert.equal(origin.calls, 0);
  });

  it("a miss calls the method and writes value + reference; a hit does not call it", async () => {
    const origin = new Origin();
    const service = new SubscriptionService(origin);

    const first = await service.getActiveSubscription(USER, { v: 1 });
    assert.deepEqual(first, { userId: USER, planId: "pro-monthly" });
    assert.equal(origin.calls, 1);
    assert.equal(await redis.get(keyFor('{"v":1}')), JSON.stringify(first));
    assert.deepEqual(await redis.smembers(INDEX_KEY), [keyFor('{"v":1}')]);
    const ttl = await redis.ttl(keyFor('{"v":1}'));
    assert.ok(ttl > 3590 && ttl <= 3600, `ttl ${ttl}`);

    origin.next = () => {
      throw new Error("a hit must not reach the origin");
    };
    assert.deepEqual(await service.getActiveSubscription(USER, { v: 1 }), first);
    assert.equal(origin.calls, 1);
  });

  it("the DEFAULT strategy writes a plain value and no index", async () => {
    const origin = new Origin();
    const service = new SubscriptionService(origin);
    assert.deepEqual(await service.getPlanConfig("pro-yearly"), { planId: "pro-yearly" });
    assert.deepEqual(await service.getPlanConfig("pro-yearly"), { planId: "pro-yearly" });
    assert.equal(origin.calls, 1);
    assert.deepEqual(await redis.keys("*"), [`${SERVICE}::${TENANT}::planConfig::pro-yearly::{}`]);
  });

  it("concurrent misses for one key collapse to a single origin call", async () => {
    const origin = new Origin();
    origin.delayMs = 50;
    const service = new SubscriptionService(origin);

    const results = await Promise.all(Array.from({ length: 20 }, () => service.getActiveSubscription(USER, { v: 1 })));
    assert.equal(origin.calls, 1);
    for (const r of results) assert.deepEqual(r, { userId: USER, planId: "pro-monthly" });

    // A different key is a different flight.
    await Promise.all([service.getActiveSubscription(USER, { v: 2 }), service.getActiveSubscription(USER, { v: 2 })]);
    assert.equal(origin.calls, 2);
  });

  it("a throwing origin is never cached: nothing is written and the next call reaches the origin", async () => {
    const origin = new Origin();
    origin.delayMs = 20;
    origin.next = () => {
      throw new Error("billing provider timeout");
    };
    const service = new SubscriptionService(origin);

    // Concurrent callers share the rejection; none of them writes.
    const attempts = await Promise.allSettled([service.getActiveSubscription(USER), service.getActiveSubscription(USER)]);
    for (const a of attempts) {
      assert.equal(a.status, "rejected");
      assert.match(String((a as PromiseRejectedResult).reason), /billing provider timeout/);
    }
    assert.equal(origin.calls, 1);
    assert.equal(await redis.dbsize(), 0, "no value and no index member after an origin error");

    origin.next = (userId) => ({ userId, planId: "team-monthly" });
    assert.deepEqual(await service.getActiveSubscription(USER), { userId: USER, planId: "team-monthly" });
    assert.equal(origin.calls, 2);
  });

  it("undefined is never cached, and null is not cached by default", async () => {
    const origin = new Origin();
    const service = new SubscriptionService(origin);

    origin.next = () => undefined;
    assert.equal(await service.getActiveSubscription(USER), undefined);
    assert.equal(await service.getActiveSubscription(USER), undefined);

    origin.next = () => null;
    assert.equal(await service.getActiveSubscription(USER), null);
    assert.equal(await service.getActiveSubscription(USER), null);

    assert.equal(origin.calls, 4);
    assert.equal(await redis.dbsize(), 0);
  });

  it("null is cached only under cacheNegative, with its own TTL", async () => {
    const origin = new Origin();
    origin.next = () => null;
    const service = new SubscriptionService(origin);

    assert.equal(await service.getWithNegative(USER), null);
    assert.equal(await service.getWithNegative(USER), null);
    assert.equal(origin.calls, 1);
    assert.equal(await redis.get(keyFor()), "null");
    const ttl = await redis.ttl(keyFor());
    assert.ok(ttl > 0 && ttl <= 60, `negative ttl ${ttl}`);
  });

  it("rejects an invalid TTL when the decorator is applied", () => {
    assert.throws(() => Cache(CacheKey.PLAN_CONFIG, 0, CacheStrategy.DEFAULT), RangeError);
  });
});
