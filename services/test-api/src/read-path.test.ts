// The read path against real Redis: a read-through fill racing an invalidation (US-009).
//
// These tests assert the DOCUMENTED outcome of the race, not a fix for it. A fill that reads the
// origin before an invalidation and writes after it lands its value and its reference together and
// serves that value until its TTL — bounded staleness. Nothing here makes fill and invalidation atomic.

import {
  buildCacheKey,
  configureCache,
  EntityIndexCacheStrategy,
  TTL,
  type RedisClient,
} from "@redis-hash-index/cache";
import {
  CATEGORY,
  recordOrdinalFor,
  recordsFor,
  SERVICE,
  TENANT,
  type Subscription,
} from "@redis-hash-index/fixture";
import Redis from "ioredis";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { createApp, type RedisReader } from "./app";
import { OriginError } from "./billing-client";
import type { SubscriptionOrigin, SubscriptionParams } from "./subscription-service";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
// app.test.ts owns DB 15; test files run in parallel.
const TEST_DB = 14;
// u_0000004 has three variants at seed 1, so v=1 and v=2 are two distinct, real records.
const USER = "u_0000004";
const FAIL_USER = "u_0000002";

const redis = new Redis(REDIS_URL, { db: TEST_DB });
const index = new EntityIndexCacheStrategy(redis as unknown as RedisClient, { categories: [CATEGORY] });
const indexKey = index.indexKeyFor(TENANT, CATEGORY, USER);
const cacheKey = (userId: string, params: SubscriptionParams): string =>
  buildCacheKey(SERVICE, TENANT, CATEGORY, [userId, params]);

/** The fixture's record, as mock-billing would answer it — no socket. FAIL_USER is an OriginError. */
function fixtureSubscription(userId: string, params: SubscriptionParams = {}): Subscription | null {
  if (userId === FAIL_USER) throw new OriginError(`billing GET /subscription/${userId} -> 503`);
  const i = Number(userId.slice(2));
  const record = recordsFor(i, 1, recordOrdinalFor(i, 1))[(params.v ?? 1) - 1];
  return record === undefined ? null : (JSON.parse(record.value) as Subscription);
}

/**
 * A fixture origin with a latch in front of it. `hold()` parks the next origin call until
 * `release()`, so "the invalidation lands mid-flight" is an ordering, not a sleep.
 */
class GatedOrigin implements SubscriptionOrigin {
  calls = 0;
  private gate: { entered: () => void; released: Promise<void> } | null = null;

  hold(): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { entered, released };
    return { entered: enteredP, release };
  }

  async getActiveSubscription(userId: string, params?: SubscriptionParams): Promise<Subscription | null> {
    this.calls += 1;
    const gate = this.gate;
    this.gate = null;
    if (gate !== null) {
      gate.entered();
      await gate.released;
    }
    return fixtureSubscription(userId, params);
  }
}

const origin = new GatedOrigin();
let server: Server;
let baseUrl: string;

before(async () => {
  configureCache({ redis: redis as unknown as RedisClient, service: SERVICE, tenant: TENANT, categories: [CATEGORY] });
  const app = createApp(redis as unknown as RedisReader, origin);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await redis.flushdb();
  origin.calls = 0;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await redis.quit();
});

async function getSubscription(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/subscription/${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("a fill in flight across an invalidation lands value and reference together and survives to its TTL", async () => {
  // Something to invalidate: an earlier, completed fill of another variant.
  const earlierKey = cacheKey(USER, { v: 1 });
  assert.equal((await getSubscription(`${USER}?v=1`)).body.source, "origin");
  assert.deepEqual(await redis.smembers(indexKey), [earlierKey]);

  // Start a fill and park it inside the origin: the decorator has already missed and will write after.
  const fillKey = cacheKey(USER, { v: 2 });
  const gate = origin.hold();
  const fill = getSubscription(`${USER}?v=2`);
  await gate.entered;

  // The invalidation lands mid-flight (the webhook's v2 path) and removes what existed at the time.
  const invalidation = await index.invalidateEntities(TENANT, CATEGORY, [USER]);
  assert.deepEqual(invalidation.incomplete, []);
  assert.equal(invalidation.valuesUnlinked, 1);
  assert.equal(invalidation.referencesRemoved, 1);
  assert.equal(await redis.exists(earlierKey), 0);
  assert.equal(await redis.dbsize(), 0, "the invalidation left nothing behind");

  // The fill resumes and writes after the invalidation finished.
  gate.release();
  const { status, body } = await fill;
  assert.equal(status, 200);
  assert.equal(body.source, "origin");
  const expected = fixtureSubscription(USER, { v: 2 });
  assert.deepEqual(body.subscription, expected);

  // Value and reference agree: the only reference names the fill's value, and the only keys are that
  // value and its index set — no orphan value, no dangling reference.
  assert.equal(await redis.get(fillKey), JSON.stringify(expected));
  assert.deepEqual(await redis.smembers(indexKey), [fillKey]);
  assert.equal(await redis.dbsize(), 2);

  // Bounded staleness: the post-invalidation value is armed with the full TTL, and the reference
  // outlives it, so nothing but that TTL — or another invalidation — removes it.
  const valueTtl = await redis.pttl(fillKey);
  assert.ok(valueTtl > (TTL.MEDIUM - 5) * 1000 && valueTtl <= TTL.MEDIUM * 1000, `value PTTL ${valueTtl}`);
  // Compare absolute expiry times: two PTTL reads a millisecond apart can make the index look shorter.
  const valueExpiresAt = Number(await redis.call("PEXPIRETIME", fillKey));
  const indexExpiresAt = Number(await redis.call("PEXPIRETIME", indexKey));
  assert.ok(indexExpiresAt >= valueExpiresAt, `index expires at ${indexExpiresAt}, before its value at ${valueExpiresAt}`);

  // Until then it is served from the cache, without another origin call.
  const callsBefore = origin.calls;
  const again = await getSubscription(`${USER}?v=2`);
  assert.equal(again.body.source, "cache");
  assert.equal(origin.calls, callsBefore);

  // And the next invalidation still finds it through the index.
  const next = await index.invalidateEntities(TENANT, CATEGORY, [USER]);
  assert.equal(next.valuesUnlinked, 1);
  assert.equal(await redis.dbsize(), 0);
});

test("an invalidation after a completed fill removes both value and reference", async () => {
  const fillKey = cacheKey(USER, { v: 2 });
  const first = await getSubscription(`${USER}?v=2`);
  assert.equal(first.status, 200);
  assert.equal(first.body.source, "origin");
  assert.equal(typeof first.body.originMs, "number");
  assert.equal(typeof first.body.latencyMs, "number");
  assert.equal(first.body.variants, 1);

  const second = await getSubscription(`${USER}?v=2`);
  assert.equal(second.body.source, "cache");
  assert.equal("originMs" in second.body, false);
  assert.deepEqual(second.body.subscription, first.body.subscription);
  assert.equal(origin.calls, 1);

  const invalidation = await index.invalidateEntities(TENANT, CATEGORY, [USER]);
  assert.deepEqual(invalidation.incomplete, []);
  assert.equal(await redis.exists(fillKey), 0);
  assert.equal(await redis.exists(indexKey), 0);
  assert.equal(await redis.dbsize(), 0);

  const third = await getSubscription(`${USER}?v=2`);
  assert.equal(third.body.source, "origin");
  assert.equal(origin.calls, 2);
});

test("an origin error returns 502, caches nothing, and the next call still reaches the origin", async () => {
  const first = await getSubscription(FAIL_USER);
  assert.equal(first.status, 502);
  assert.equal(typeof first.body.error, "string");
  assert.equal(origin.calls, 1);
  assert.equal(await redis.exists(cacheKey(FAIL_USER, {})), 0);
  assert.equal(await redis.exists(index.indexKeyFor(TENANT, CATEGORY, FAIL_USER)), 0);
  assert.equal(await redis.dbsize(), 0, "no value and no index member");

  const second = await getSubscription(FAIL_USER);
  assert.equal(second.status, 502);
  assert.equal(origin.calls, 2);
  assert.equal(await redis.dbsize(), 0);
});
