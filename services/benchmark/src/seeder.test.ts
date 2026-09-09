import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";

import Redis from "ioredis";
import { WebSocket } from "ws";
import { EntityIndex, type RedisClient } from "@redis-hash-index/cache";

import { createApp } from "./app";
import { MARKER_KEY } from "./config";
import { expectedTotals } from "./fixture";
import {
  AlreadySeedingError,
  Seeder,
  type SeederPipeline,
  type SeederRedis,
  type SeedMarker,
  type SeedState,
} from "./seeder";
import { attachWebSocket } from "./ws";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_DB = 15;
const SEED_KEYS = 400;
const SEED_VALUE = 1;

const redis = new Redis(REDIS_URL, { db: TEST_DB });
const index = new EntityIndex(redis as unknown as RedisClient, {
  categories: ["activeSubscription"],
});

/** Close an HTTP server without waiting on undici keep-alive sockets from `fetch`. */
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const newSeeder = (seedKeys = SEED_KEYS, seedValue = SEED_VALUE): Seeder =>
  new Seeder(redis as unknown as SeederRedis, index, {
    seedKeys,
    seedValue,
    pipelineSize: 20_000,
  });

async function seedToReady(seeder: Seeder): Promise<SeedMarker> {
  seeder.start();
  const [marker] = (await once(seeder, "done")) as [SeedMarker];
  return marker;
}

/** Poll status until the seed leaves the `seeding` state (it may already have, hence no event wait). */
async function waitSettled(seeder: Seeder): Promise<SeedState> {
  for (;;) {
    const { state } = await seeder.status();
    if (state !== "seeding") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

before(async () => {
  await redis.flushdb();
});

after(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushdb();
});

test("seeds the deterministic fixture and asserts DBSIZE, then writes a marker", async () => {
  const seeder = newSeeder();
  const marker = await seedToReady(seeder);

  const totals = expectedTotals(SEED_KEYS, SEED_VALUE);
  assert.deepEqual(
    { users: marker.users, cacheKeys: marker.cacheKeys, indexKeys: marker.indexKeys },
    totals,
  );
  assert.equal(marker.seedValue, SEED_VALUE);

  // DBSIZE at completion is the fixture plus the marker key itself.
  assert.equal(await redis.dbsize(), totals.cacheKeys + totals.indexKeys + 1);

  const status = await seeder.status();
  assert.equal(status.state, "ready");
  assert.equal(status.progress, 1);
  assert.equal(status.cacheKeys, totals.cacheKeys);
  assert.match(status.memoryHuman, /\d/);

  const stored = JSON.parse((await redis.get(MARKER_KEY)) ?? "null") as SeedMarker;
  assert.equal(stored.cacheKeys, totals.cacheKeys);
});

test("cache strings and index sets are written with an armed TTL (NX then GT)", async () => {
  await seedToReady(newSeeder());

  const cacheKey = 'test-api::demo::activeSubscription::u_0000000::{"v":1}';
  const raw = await redis.get(cacheKey);
  assert.ok(raw, "expected the first user's first variant to exist");
  const parsed = JSON.parse(raw) as { userId: string };
  assert.equal(parsed.userId, "u_0000000");
  const cacheTtl = await redis.ttl(cacheKey);
  assert.ok(cacheTtl > 0 && cacheTtl <= 3600, `cache ttl ${cacheTtl}`);

  const indexKey = "entityIndex::demo::activeSubscription::u_0000000";
  const members = await redis.smembers(indexKey);
  assert.ok(members.includes(cacheKey));
  const indexTtl = await redis.ttl(indexKey);
  assert.ok(indexTtl > 0 && indexTtl <= 3600, `index ttl ${indexTtl} — NX/GT did not arm the set`);
});

test("reseeding with the same seed is byte-identical", async () => {
  const marker1 = await seedToReady(newSeeder());
  const sampleKey = 'test-api::demo::activeSubscription::u_0000003::{"v":1}';
  const value1 = await redis.get(sampleKey);
  const dbsize1 = await redis.dbsize();

  const marker2 = await seedToReady(newSeeder());
  assert.equal(await redis.get(sampleKey), value1);
  assert.equal(await redis.dbsize(), dbsize1);
  assert.deepEqual(
    { u: marker1.cacheKeys, i: marker1.indexKeys },
    { u: marker2.cacheKeys, i: marker2.indexKeys },
  );
});

test("a different seed produces a different fixture", async () => {
  await seedToReady(newSeeder(SEED_KEYS, 1));
  const key = 'test-api::demo::activeSubscription::u_0000005::{"v":1}';
  const a = await redis.get(key);
  await redis.flushdb();
  await seedToReady(newSeeder(SEED_KEYS, 2));
  assert.notEqual(await redis.get(key), a);
});

test("init() reports ready from a marker left by a previous run without reseeding", async () => {
  await seedToReady(newSeeder());
  const fresh = newSeeder();
  await fresh.init();
  const status = await fresh.status();
  assert.equal(status.state, "ready");
  assert.equal(status.progress, 1);
});

test("reset flushes the fixture and the marker", async () => {
  const seeder = newSeeder();
  await seedToReady(seeder);
  await seeder.reset();
  assert.equal(await redis.dbsize(), 0);
  assert.equal(await redis.get(MARKER_KEY), null);
  assert.equal((await seeder.status()).state, "idle");
});

test("start() refuses a concurrent seed", async () => {
  const seeder = newSeeder();
  seeder.start();
  assert.throws(() => seeder.start(), AlreadySeedingError);
  await once(seeder, "done");
});

test("a pipeline error reply aborts seeding and sets state failed", async () => {
  const failing: SeederRedis = {
    pipeline(): SeederPipeline {
      const p: SeederPipeline = {
        set: () => p,
        sadd: () => p,
        expire: () => p,
        exec: async () => [[new Error("boom"), null]],
      };
      return p;
    },
    dbsize: async () => 0,
    get: async () => null,
    set: async () => "OK",
    flushdb: async () => "OK",
    info: async () => "used_memory_human:1.00M",
  };
  const seeder = new Seeder(failing, index, { seedKeys: 10, seedValue: 1, pipelineSize: 20_000 });
  seeder.start();
  const [message] = (await once(seeder, "failed")) as [string];
  assert.match(message, /boom/);
  assert.equal((await seeder.status()).state, "failed");
});

test("HTTP: POST /api/seed is 202, a second is 409, status then reports ready", async () => {
  // A larger fixture so the second POST reliably lands while the first seed is still running.
  const seeder = newSeeder(40_000);
  await seeder.init();
  const app = createApp({ seeder });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app).listen(0, () => resolve(s));
  });
  const hub = attachWebSocket(server, seeder);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const started = await fetch(`${base}/api/seed`, { method: "POST" });
    assert.equal(started.status, 202);

    const rejected = await fetch(`${base}/api/seed`, { method: "POST" });
    assert.equal(rejected.status, 409);

    assert.equal(await waitSettled(seeder), "ready");

    const status = (await (await fetch(`${base}/api/seed/status`)).json()) as {
      state: string;
      progress: number;
    };
    assert.equal(status.state, "ready");
    assert.equal(status.progress, 1);

    const reset = await fetch(`${base}/api/seed/reset`, { method: "POST" });
    assert.equal(reset.status, 200);
    const afterReset = (await (await fetch(`${base}/api/seed/status`)).json()) as { state: string };
    assert.equal(afterReset.state, "idle");
  } finally {
    await hub.close();
    await closeServer(server);
  }
});

test("WebSocket receives seed-progress frames ending at percent 1", async () => {
  const seeder = newSeeder();
  const app = createApp({ seeder });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app).listen(0, () => resolve(s));
  });
  const hub = attachWebSocket(server, seeder);
  const { port } = server.address() as AddressInfo;

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: Array<{ t: string; percent: number }> = [];
  socket.on("message", (data: Buffer) => {
    frames.push(JSON.parse(data.toString()) as { t: string; percent: number });
  });

  try {
    await once(socket, "open");
    seeder.start();
    await once(seeder, "done");
    // let the terminal progress frame flush to the socket
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(frames.length > 0);
    assert.ok(frames.every((f) => f.t === "seed-progress"));
    assert.equal(frames.at(-1)?.percent, 1);
  } finally {
    socket.terminate();
    await hub.close();
    await closeServer(server);
  }
});
