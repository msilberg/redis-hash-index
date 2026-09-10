import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import Redis from "ioredis";

import { EntityIndex, INDEX_PREFIX, type RedisClient } from "./index";

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

const newIndex = (client: RedisClient = redis as unknown as RedisClient): EntityIndex =>
  new EntityIndex(client, { categories: [CATEGORY], batchSize: 500, concurrency: 4 });

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
      smembers: (k) => redis.smembers(k),
      srem: (k, ...m) => redis.srem(k, ...m),
      multi: () => redis.multi() as unknown as ReturnType<RedisClient["multi"]>,
      pipeline: () => redis.pipeline() as unknown as ReturnType<RedisClient["pipeline"]>,
      unlink: () => {
        failed = true;
        return Promise.reject(new Error("injected UNLINK failure"));
      },
    };

    await assert.rejects(new EntityIndex(flaky, { categories: [CATEGORY] }).invalidateEntities(TENANT, CATEGORY, [USER]));
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

    await new EntityIndex(racyClient, { categories: [CATEGORY] }).invalidateEntities(TENANT, CATEGORY, [USER]);

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
