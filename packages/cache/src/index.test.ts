import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import Redis from "ioredis";

import { EntityIndexCacheStrategy, INDEX_PREFIX, type RedisClient } from "./index";

// These tests need a real Redis — three of them only reproduce against real command semantics
// (NX/GT expiry, MULTI without rollback, SREM vs a concurrent writer). `make test` brings up the
// compose `redis` first; override with REDIS_URL to point elsewhere.
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const TEST_DB = 15;

const TENANT = "demo";
const CATEGORY = "activeSubscription";
const USER = "u_0000042";
const INDEX_KEY = `${INDEX_PREFIX}::${TENANT}::${CATEGORY}::${USER}`;

const cacheKey = (user: string, variant: number): string =>
  `test-api::${TENANT}::${CATEGORY}::${user}::{"v":${variant}}`;

let redis: Redis;

const newIndex = (client: RedisClient = redis as unknown as RedisClient): EntityIndexCacheStrategy =>
  new EntityIndexCacheStrategy(client, { categories: [CATEGORY], batchSize: 500, concurrency: 4 });

before(async () => {
  redis = new Redis(REDIS_URL, { db: TEST_DB, maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();
});

after(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushdb();
});

describe("indexKeyFor / parse", () => {
  it("builds the index key from the entity coordinates", () => {
    assert.equal(newIndex().indexKeyFor(TENANT, CATEGORY, USER), INDEX_KEY);
  });

  it("rejects a segment containing the delimiter instead of addressing a neighbour namespace", () => {
    assert.throws(() => newIndex().indexKeyFor(TENANT, CATEGORY, `${USER}::evil`));
  });

  it("rejects an unknown category", () => {
    assert.throws(() => newIndex().indexKeyFor(TENANT, "somethingElse", USER));
  });

  it("parses a well-formed cache key and derives its index key", () => {
    const parsed = newIndex().parse(cacheKey(USER, 2));
    assert.deepEqual(parsed, {
      service: "test-api",
      tenant: TENANT,
      entity: CATEGORY,
      entityId: USER,
      params: '{"v":2}',
      indexKey: INDEX_KEY,
    });
  });

  it("returns null (never throws) for a non-cache-key or foreign category", () => {
    const index = newIndex();
    assert.equal(index.parse("not-a-key"), null);
    assert.equal(index.parse(INDEX_KEY), null);
    assert.equal(index.parse(`test-api::${TENANT}::otherCategory::${USER}::{"v":1}`), null);
  });
});

describe("register — NX then GT", () => {
  it("first register sets an expiry; a longer TTL extends it; a shorter one does not pull it back", async () => {
    const index = newIndex();

    const added = await index.register(cacheKey(USER, 1), 100);
    assert.equal(added, true);
    const t1 = await redis.ttl(INDEX_KEY);
    assert.ok(t1 > 90 && t1 <= 100, `expected ~100, got ${t1}`);

    await index.register(cacheKey(USER, 2), 200);
    const t2 = await redis.ttl(INDEX_KEY);
    assert.ok(t2 > 150 && t2 <= 200, `expected ~200 after GT extend, got ${t2}`);

    await index.register(cacheKey(USER, 3), 50);
    const t3 = await redis.ttl(INDEX_KEY);
    assert.ok(t3 > 150, `expected TTL to stay ~200, got ${t3}`);

    assert.deepEqual((await redis.smembers(INDEX_KEY)).sort(), [
      cacheKey(USER, 1),
      cacheKey(USER, 2),
      cacheKey(USER, 3),
    ]);
  });

  it("a rejected TTL writes nothing at all", async () => {
    const index = newIndex();
    for (const bad of [0, -1, 1.5, 2_592_001, Number.NaN]) {
      await assert.rejects(index.register(cacheKey(USER, 1), bad), RangeError);
    }
    assert.equal(await redis.exists(INDEX_KEY), 0);
  });
});

describe("invalidateEntities", () => {
  it("removes every cache value and index reference for the targeted users", async () => {
    const index = newIndex();
    for (const user of [USER, "u_0000043"]) {
      for (const v of [1, 2, 3]) {
        await redis.set(cacheKey(user, v), "x");
        await index.register(cacheKey(user, v), 3600);
      }
    }

    const result = await index.invalidateEntities(TENANT, CATEGORY, [USER, "u_0000043"]);
    assert.equal(result.entities, 2);
    assert.equal(result.membersObserved, 6);
    assert.equal(result.valuesUnlinked, 6);
    assert.equal(result.referencesRemoved, 6);

    for (const user of [USER, "u_0000043"]) {
      assert.equal(await redis.exists(`${INDEX_PREFIX}::${TENANT}::${CATEGORY}::${user}`), 0);
      for (const v of [1, 2, 3]) {
        assert.equal(await redis.exists(cacheKey(user, v)), 0);
      }
    }
  });

  it("a failing UNLINK leaves both references in place, and a retry removes everything", async () => {
    for (const v of [1, 2]) {
      await redis.set(cacheKey(USER, v), "x");
      await newIndex().register(cacheKey(USER, v), 3600);
    }

    let failed = false;
    const flaky: RedisClient = {
      get: (k) => redis.get(k),
      set: (k, v, mode, seconds) => redis.set(k, v, mode, seconds),
      smembers: (k) => redis.smembers(k),
      sscan: (k, cursor, count, size) => redis.sscan(k, cursor, count, size),
      srem: (k, ...m) => redis.srem(k, ...m),
      multi: () => redis.multi() as unknown as ReturnType<RedisClient["multi"]>,
      pipeline: () => redis.pipeline() as unknown as ReturnType<RedisClient["pipeline"]>,
      unlink: () => {
        failed = true;
        return Promise.reject(new Error("injected UNLINK failure"));
      },
    };

    const result = await new EntityIndexCacheStrategy(flaky, { categories: [CATEGORY] })
      .invalidateEntities(TENANT, CATEGORY, [USER]);
    assert.equal(result.entities, 0);
    assert.deepEqual(result.incomplete, [{ entityId: USER, error: "injected UNLINK failure" }]);
    assert.equal(failed, true);

    // Index intact: nothing was removed because values are deleted before references.
    assert.deepEqual((await redis.smembers(INDEX_KEY)).sort(), [cacheKey(USER, 1), cacheKey(USER, 2)]);
    assert.equal(await redis.exists(cacheKey(USER, 1)), 1);
    assert.equal(await redis.exists(cacheKey(USER, 2)), 1);

    // Same call, real client, finishes the job.
    await newIndex().invalidateEntities(TENANT, CATEGORY, [USER]);
    assert.equal(await redis.exists(INDEX_KEY), 0);
    assert.equal(await redis.exists(cacheKey(USER, 1)), 0);
    assert.equal(await redis.exists(cacheKey(USER, 2)), 0);
  });

  it("a member added between SMEMBERS and SREM survives", async () => {
    await redis.set(cacheKey(USER, 1), "x");
    await newIndex().register(cacheKey(USER, 1), 3600);

    const raced = cacheKey(USER, 9);
    let injected = false;
    const racyClient: RedisClient = {
      get: (k) => redis.get(k),
      set: (k, v, mode, seconds) => redis.set(k, v, mode, seconds),
      sscan: (k, cursor, count, size) => redis.sscan(k, cursor, count, size),
      srem: (k, ...m) => redis.srem(k, ...m),
      unlink: (...k) => redis.unlink(...k),
      multi: () => redis.multi() as unknown as ReturnType<RedisClient["multi"]>,
      pipeline: () => redis.pipeline() as unknown as ReturnType<RedisClient["pipeline"]>,
      smembers: async (k) => {
        const members = await redis.smembers(k);
        if (!injected) {
          injected = true;
          await redis.sadd(k, raced); // a concurrent writer, after we read
        }
        return members;
      },
    };

    await new EntityIndexCacheStrategy(racyClient, { categories: [CATEGORY] }).invalidateEntities(TENANT, CATEGORY, [USER]);

    assert.equal(injected, true);
    assert.deepEqual(await redis.smembers(INDEX_KEY), [raced]);
  });

  it("invalidates 200,000 members without a RangeError (batched, not spread)", async () => {
    const total = 200_000;
    for (let i = 0; i < total; i += 10_000) {
      const pipe = redis.pipeline();
      for (let j = i; j < i + 10_000; j++) pipe.sadd(INDEX_KEY, cacheKey(USER, j));
      const replies = await pipe.exec();
      assert.ok(replies);
      for (const [err] of replies) assert.equal(err, null);
    }
    assert.equal(await redis.scard(INDEX_KEY), total);

    const result = await newIndex().invalidateEntities(TENANT, CATEGORY, [USER]);
    assert.equal(result.membersObserved, total);
    assert.equal(result.referencesRemoved, total);
    assert.equal(await redis.exists(INDEX_KEY), 0);
  });
});

describe("prune", () => {
  it("drops references whose cache value is gone and keeps the live ones", async () => {
    const index = newIndex();
    await redis.set(cacheKey(USER, 1), "x");
    await index.register(cacheKey(USER, 1), 3600);
    await index.register(cacheKey(USER, 2), 3600); // never had a value

    const result = await index.prune(TENANT, CATEGORY, USER);
    assert.equal(result.membersChecked, 2);
    assert.equal(result.membersRemoved, 1);
    assert.deepEqual(await redis.smembers(INDEX_KEY), [cacheKey(USER, 1)]);
  });
});

describe("registerMany", () => {
  it("writes values and references across bounded transactions with NX/GT and duplicate handling", async () => {
    const index = new EntityIndexCacheStrategy(redis as unknown as RedisClient, {
      categories: [CATEGORY], batchSize: 2,
    });
    const records = [1, 2, 3].map((v) => ({
      cacheKey: cacheKey(USER, v), value: "value", ttlSeconds: v === 2 ? 200 : 100,
    }));
    assert.equal(await index.registerMany(records), 3);
    assert.equal(await index.registerMany(records), 0);
    assert.equal(await index.register(cacheKey(USER, 1), 50), false);
    assert.ok((await redis.ttl(INDEX_KEY)) > 150);
    for (const record of records) {
      assert.equal(await redis.get(record.cacheKey), "value");
      assert.ok((await redis.ttl(record.cacheKey)) > 0);
    }
    assert.deepEqual((await redis.smembers(INDEX_KEY)).sort(), records.map((r) => r.cacheKey));
    assert.equal(await index.registerMany([]), 0);
  });

  it("validates the entire batch before any writes, even beyond a transaction boundary", async () => {
    const index = new EntityIndexCacheStrategy(redis as unknown as RedisClient, {
      categories: [CATEGORY], batchSize: 1,
    });
    const valid = { cacheKey: cacheKey(USER, 1), value: "x", ttlSeconds: 100 };
    for (const invalid of [
      { ...valid, ttlSeconds: 0 },
      { ...valid, cacheKey: "malformed" },
      { ...valid, cacheKey: cacheKey(USER, 2).replace(CATEGORY, "unknown") },
    ]) {
      await assert.rejects(index.registerMany([valid, invalid]));
      assert.equal(await redis.dbsize(), 0);
    }
  });

  it("reports a runtime MULTI error rather than silently accepting a partial write", async () => {
    await redis.set(INDEX_KEY, "wrong type");
    await assert.rejects(newIndex().registerMany([
      { cacheKey: cacheKey(USER, 1), value: "x", ttlSeconds: 100 },
    ]), /WRONGTYPE/);
    // Redis does not roll back SET when SADD fails at runtime.
    assert.equal(await redis.get(cacheKey(USER, 1)), "x");
  });
});

describe("batch failure reporting", () => {
  it("continues other entities, retains partial counters, and retries only the incomplete IDs", async () => {
    const goodUser = "u_0000043";
    const index = newIndex();
    await index.registerMany([USER, goodUser].flatMap((user) =>
      [1, 2].map((v) => ({ cacheKey: cacheKey(user, v), value: "x", ttlSeconds: 100 })),
    ));
    let active = 0;
    let peak = 0;
    const client = new Proxy(redis, {
      get(target, prop) {
        if (prop === "smembers") return async (key: string) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          try { return await target.smembers(key); } finally { active -= 1; }
        };
        if (prop === "unlink") return async (...keys: string[]) => {
          if (keys.includes(cacheKey(USER, 2))) throw new Error("second batch failed");
          return target.unlink(...keys);
        };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await new EntityIndexCacheStrategy(client as unknown as RedisClient, {
      categories: [CATEGORY], batchSize: 1, concurrency: 2,
    }).invalidateEntities(TENANT, CATEGORY, [USER, goodUser]);
    assert.equal(peak, 2);
    assert.equal(result.entities, 1);
    assert.equal(result.membersObserved, 4);
    // SMEMBERS order is unspecified, so one or zero of the failing user's values was removed.
    assert.equal(result.valuesUnlinked, 4 - await redis.exists(
      cacheKey(USER, 1), cacheKey(USER, 2), cacheKey(goodUser, 1), cacheKey(goodUser, 2),
    ));
    assert.equal(result.referencesRemoved, 2);
    assert.deepEqual(result.incomplete, [{ entityId: USER, error: "second batch failed" }]);
    assert.equal(await redis.scard(INDEX_KEY), 2);
    const retry = await index.invalidateEntities(TENANT, CATEGORY, result.incomplete.map((f) => f.entityId));
    assert.deepEqual(retry.incomplete, []);
    assert.equal(retry.entities, 1);
    assert.equal(await redis.dbsize(), 0);
  });
});

describe("cursor pruning", () => {
  it("continues empty pages, tolerates duplicates, and chunks oversized scan replies", async () => {
    const live = cacheKey(USER, 1);
    const missing = [2, 3, 4].map((v) => cacheKey(USER, v));
    await redis.set(live, "x");
    await redis.sadd(INDEX_KEY, live, ...missing);
    const pages: Array<[string, string[]]> = [
      ["1", []], ["2", [live, ...missing]], ["0", [live, ...missing]],
    ];
    let calls = 0;
    const client = new Proxy(redis, {
      get(target, prop) {
        if (prop === "sscan") return async () => {
          const page = pages[calls++];
          assert.ok(page, "cursor should stop at zero");
          return page;
        };
        if (prop === "srem") return async (key: string, ...members: string[]) => {
          assert.ok(members.length <= 2);
          return target.srem(key, ...members);
        };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await new EntityIndexCacheStrategy(client as unknown as RedisClient, {
      categories: [CATEGORY], batchSize: 2,
    }).prune(TENANT, CATEGORY, USER);
    assert.equal(calls, 3);
    assert.equal(result.membersChecked, 8);
    assert.equal(result.membersRemoved, 3);
    assert.deepEqual(await redis.smembers(INDEX_KEY), [live]);
  });

  it("walks a large set incrementally, keeping live values and bounding removal batches", async () => {
    const records = Array.from({ length: 5000 }, (_, v) => ({
      cacheKey: cacheKey(USER, v), ttlSeconds: 100,
      ...(v % 10 === 0 ? { value: "live" } : {}),
    }));
    await newIndex().registerMany(records);
    let scans = 0;
    const client = new Proxy(redis, {
      get(target, prop) {
        if (prop === "smembers") return () => { throw new Error("prune must not SMEMBERS"); };
        if (prop === "sscan") return async (key: string, cursor: string, count: "COUNT", size: number) => {
          scans += 1;
          return target.sscan(key, cursor, count, size);
        };
        if (prop === "srem") return async (key: string, ...members: string[]) => {
          assert.ok(members.length <= 17);
          return target.srem(key, ...members);
        };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await new EntityIndexCacheStrategy(client as unknown as RedisClient, {
      categories: [CATEGORY], batchSize: 17,
    }).prune(TENANT, CATEGORY, USER);
    assert.ok(scans > 1);
    assert.ok(result.membersChecked >= 5000);
    assert.equal(result.membersRemoved, 4500);
    assert.equal(await redis.scard(INDEX_KEY), 500);
    assert.equal((await newIndex().prune(TENANT, CATEGORY, "u_9999999")).membersChecked, 0);
  });
});
