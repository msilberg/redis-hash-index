import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import Redis from "ioredis";
import { EntityIndex, type RedisClient } from "@redis-hash-index/cache";
import { createApp, type TestApiRedis } from "./app";
import { BillingOrigin } from "./origin";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_DB = 15;

const redis = new Redis(REDIS_URL, { db: TEST_DB });
const index = new EntityIndex(redis as unknown as RedisClient, {
  categories: ["activeSubscription"],
});

const FAIL_USER = "u_0000002";
const origin = new BillingOrigin({ latencyMs: 20, failUser: FAIL_USER, seedValue: 1 });

let server: Server;
let baseUrl: string;

before(async () => {
  await redis.flushdb();
  const app = createApp(redis as unknown as TestApiRedis, origin);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
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

async function seedUser(userId: string, variants: number): Promise<void> {
  for (let v = 1; v <= variants; v += 1) {
    const key = `test-api::demo::activeSubscription::${userId}::{"v":${v}}`;
    await redis.set(
      key,
      JSON.stringify({ userId, planId: "pro-monthly", status: "active" }),
      "EX",
      3600,
    );
    await index.register(key, 3600);
  }
}

test("GET /health returns {ok:true}", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("GET /entitlement/:userId reports a hit, the variant count and a latency", async () => {
  await seedUser("u_0000001", 2);
  const res = await fetch(`${baseUrl}/entitlement/u_0000001`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.userId, "u_0000001");
  assert.equal(body.hit, true);
  assert.equal(body.variants, 2);
  assert.equal(typeof body.latencyMs, "number");
  assert.ok((body.latencyMs as number) >= 0);
});

test("GET /entitlement/:userId returns hit:false, variants:0 for an unseeded user", async () => {
  const res = await fetch(`${baseUrl}/entitlement/u_9999999`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.hit, false);
  assert.equal(body.variants, 0);
});

test("GET /entitlement/:userId rejects a malformed id with 400", async () => {
  const res = await fetch(`${baseUrl}/entitlement/bogus`);
  assert.equal(res.status, 400);
});

type SubscriptionBody = {
  userId: string;
  source: string;
  variants: number;
  latencyMs: number;
  originMs?: number;
  subscription: Record<string, unknown> | null;
};

test("GET /subscription/:userId fills from the origin, then serves from cache", async () => {
  const url = `${baseUrl}/subscription/u_0000003?includeAddons=true`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  const miss = (await first.json()) as SubscriptionBody;
  assert.equal(miss.userId, "u_0000003");
  assert.equal(miss.source, "origin");
  assert.equal(typeof miss.originMs, "number");
  assert.ok((miss.originMs as number) >= 15, "origin latency is reported separately");
  assert.ok(miss.latencyMs < miss.originMs!, "latencyMs is the Redis round trip only");
  assert.equal(miss.variants, 1);
  assert.equal(miss.subscription?.userId, "u_0000003");
  assert.ok(Array.isArray(miss.subscription?.addons));

  const key = 'test-api::demo::activeSubscription::u_0000003::{"includeAddons":true}';
  assert.equal(await redis.exists(key), 1);
  assert.deepEqual(await redis.smembers(index.indexKeyFor("demo", "activeSubscription", "u_0000003")), [key]);

  const second = await fetch(url);
  const hit = (await second.json()) as SubscriptionBody;
  assert.equal(hit.source, "cache");
  assert.equal("originMs" in hit, false);
  assert.deepEqual(hit.subscription, miss.subscription);

  const plain = (await (await fetch(`${baseUrl}/subscription/u_0000003`)).json()) as SubscriptionBody;
  assert.equal(plain.source, "origin", "different params are a different key");
  assert.equal(plain.variants, 2);
  assert.equal(plain.subscription?.addons, undefined);
});

test("GET /subscription/:userId caches the origin's authoritative 'no subscription' briefly", async () => {
  // u_0000015 has no subscription under SEED_VALUE 1: a real answer, not an error.
  const first = (await (await fetch(`${baseUrl}/subscription/u_0000015`)).json()) as SubscriptionBody;
  assert.equal(first.source, "origin");
  assert.equal(first.subscription, null);
  const key = 'test-api::demo::activeSubscription::u_0000015::{"includeAddons":false}';
  const ttl = await redis.ttl(key);
  assert.ok(ttl > 0 && ttl <= 60, `negative TTL ${ttl}`);
  const second = (await (await fetch(`${baseUrl}/subscription/u_0000015`)).json()) as SubscriptionBody;
  assert.equal(second.source, "cache");
  assert.equal(second.subscription, null);
});

test("GET /subscription/:userId returns 502 for a failing origin and writes nothing", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(`${baseUrl}/subscription/${FAIL_USER}`);
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /billing provider unavailable/);
  }
  const indexKey = index.indexKeyFor("demo", "activeSubscription", FAIL_USER);
  assert.equal(await redis.exists(indexKey), 0);
  assert.equal(await redis.exists(`test-api::demo::activeSubscription::${FAIL_USER}::{"includeAddons":false}`), 0);
});

test("GET /subscription/:userId validates the id and includeAddons", async () => {
  assert.equal((await fetch(`${baseUrl}/subscription/bogus`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/subscription/u_0000001?includeAddons=yes`)).status, 400);
});
