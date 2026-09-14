import { EntityIndexCacheStrategy, type RedisClient } from "@redis-hash-index/cache";
import Redis from "ioredis";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp, type RedisReader } from "./app";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_DB = 15;

const redis = new Redis(REDIS_URL, { db: TEST_DB });
const index = new EntityIndexCacheStrategy(redis as unknown as RedisClient, {
  categories: ["activeSubscription"],
});

let server: Server;
let baseUrl: string;

before(async () => {
  await redis.flushdb();
  // `?fill=false` never reaches the origin, and the 400 cases below are rejected before it. Any call
  // to it answers 502, so an accidental fill fails these tests loudly.
  const origin = { getActiveSubscription: () => Promise.reject(new Error("origin must not be called")) };
  const app = createApp(redis as unknown as RedisReader, origin);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
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

test("GET /subscription/:userId?fill=false reports a cache hit, the variant count and a latency", async () => {
  await seedUser("u_0000001", 2);
  const res = await fetch(`${baseUrl}/subscription/u_0000001?fill=false`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.userId, "u_0000001");
  assert.equal(body.source, "cache");
  assert.equal(body.hit, true);
  assert.equal(body.variants, 2);
  assert.equal(typeof body.latencyMs, "number");
  assert.ok((body.latencyMs as number) >= 0);
  assert.equal("subscription" in body, false);
});

test("GET /subscription/:userId?fill=false is a 200 miss for an uncached user, not an error", async () => {
  const res = await fetch(`${baseUrl}/subscription/u_9999999?fill=false`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.source, "miss");
  assert.equal(body.hit, false);
  assert.equal(body.variants, 0);
});

test("GET /subscription/:userId?fill=false ignores ?v= rather than rejecting it", async () => {
  await seedUser("u_0000003", 1);
  for (const v of ["2", "0", "two"]) {
    const res = await fetch(`${baseUrl}/subscription/u_0000003?fill=false&v=${v}`);
    assert.equal(res.status, 200, `v=${v}`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.variants, 1, `v=${v}`);
  }
});

test("GET /subscription/:userId rejects a malformed id or query with 400 before touching the cache", async () => {
  for (const path of [
    "/subscription/bogus",
    "/subscription/bogus?fill=false",
    "/subscription/u_0000001?v=0",
    "/subscription/u_0000001?v=two",
    "/subscription/u_0000001?fill=no",
  ]) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 400, path);
  }
});
