import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import Redis from "ioredis";
import { EntityIndex, type RedisClient } from "@redis-hash-index/cache";
import { createApp, type RedisReader } from "./app";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_DB = 15;

const redis = new Redis(REDIS_URL, { db: TEST_DB });
const index = new EntityIndex(redis as unknown as RedisClient, {
  categories: ["activeSubscription"],
});

let server: Server;
let baseUrl: string;

before(async () => {
  await redis.flushdb();
  const app = createApp(redis as unknown as RedisReader);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
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
