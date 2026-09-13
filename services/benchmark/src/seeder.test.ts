import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";

import Redis from "ioredis";
import { WebSocket } from "ws";
import { EntityIndexCacheStrategy, type RedisClient } from "@redis-hash-index/cache";
import { expectedTotals, generateUsers, recordOrdinalFor, recordsFor } from "@redis-hash-index/fixture";

import { createApp } from "./app";
import { CACHE_TTL_SECONDS, CATEGORY, MARKER_KEY, TENANT, type SeedMode } from "./config";
import { OriginFailedError } from "./lazy-filler";
import { Runner } from "./runner";
import {
  AlreadySeedingError,
  Seeder,
  SeedRefusedError,
  type LazyFiller,
  type SeederConfig,
  type SeederRedis,
  type SeedMarker,
  type SeedProgressFrame,
  type SeedState,
} from "./seeder";
import { attachWebSocket } from "./ws";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_DB = 15;
const SEED_KEYS = 400;
const SEED_VALUE = 1;

const redis = new Redis(REDIS_URL, { db: TEST_DB });
const index = new EntityIndexCacheStrategy(redis as unknown as RedisClient, {
  categories: ["activeSubscription"],
});

/**
 * An in-process stand-in for test-api → mock-billing, so these tests exercise the seeder's phases and
 * accounting without two more services. It writes a record the way test-api's @Cache does (value and
 * index reference in one registerMany MULTI). The real chain — and byte-identity with the bulk writer
 * across it — is tested in services/test-api/src/chain.test.ts and by `make verify`.
 */
function fakeChain(
  opts: { failUser?: string; seedValue?: number; originSeedValue?: number } = {},
): { filler: LazyFiller; originCalls: string[] } {
  const seedValue = opts.seedValue ?? SEED_VALUE;
  const originCalls: string[] = [];
  const filler: LazyFiller = {
    originSeedValue: () => Promise.resolve(opts.originSeedValue ?? seedValue),
    fill: async (userId, variant) => {
      originCalls.push(userId);
      if (userId === opts.failUser) throw new OriginFailedError(`billing GET /subscription/${userId} -> 503`);
      const i = Number(userId.slice(2));
      const record = recordsFor(i, seedValue, recordOrdinalFor(i, seedValue))[variant - 1];
      if (record === undefined) throw new Error(`no record for ${userId} v${variant}`);
      await index.registerMany([{ ...record, ttlSeconds: CACHE_TTL_SECONDS }]);
    },
  };
  return { filler, originCalls };
}

const seederConfig = (over: Partial<SeederConfig> = {}): SeederConfig => ({
  seedKeys: SEED_KEYS,
  seedValue: SEED_VALUE,
  pipelineSize: 20_000,
  seedMode: "bulk",
  lazyConcurrency: 16,
  lazyMaxKeys: 50_000,
  lazyWarmUsers: 50,
  ...over,
});

/** Close an HTTP server without waiting on undici keep-alive sockets from `fetch`. */
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** An inert run driver — these tests never start a run; they just need `createApp` to have one. */
const idleRunner = (s: Seeder): Runner =>
  new Runner(s, {
    testApiBaseUrl: "http://127.0.0.1:1",
    webhookBaseUrl: "http://127.0.0.1:1",
    pollIntervalMs: 1000,
    batchDelayMs: 1000,
    batchUsers: 1000,
    pollTimeoutMs: 30_000,
    historyCap: 3600,
  });

const newSeeder = (seedKeys = SEED_KEYS, seedValue = SEED_VALUE, over: Partial<SeederConfig> = {}): Seeder =>
  new Seeder(
    redis as unknown as SeederRedis,
    index,
    fakeChain({ seedValue }).filler,
    seederConfig({ seedKeys, seedValue, ...over }),
  );

async function seedToReady(seeder: Seeder): Promise<SeedMarker> {
  const done = once(seeder, "done");
  await seeder.start();
  const [marker] = (await done) as [SeedMarker];
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
  const done = once(seeder, "done");
  const first = seeder.start();
  await assert.rejects(seeder.start(), AlreadySeedingError);
  await first;
  await done;
});

test("a shared registration transaction error fails seeding without publishing a marker", async () => {
  const failing = new Proxy(redis, {
    get(target, prop) {
      if (prop === "flushdb") return async () => {
        await target.flushdb();
        // A real runtime SADD error inside registerMany's MULTI.
        await target.set("entityIndex::demo::activeSubscription::u_0000000", "wrong type");
        return "OK";
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const seeder = new Seeder(failing as unknown as SeederRedis, index, fakeChain().filler, seederConfig({
    seedKeys: 10,
  }));
  const failed = once(seeder, "failed");
  await seeder.start();
  const [message] = (await failed) as [string];
  assert.match(message, /WRONGTYPE/);
  assert.equal((await seeder.status()).state, "failed");
  assert.equal(await redis.get(MARKER_KEY), null);
});

test("HTTP: POST /api/seed is 202, a second is 409, status then reports ready", async () => {
  // A larger fixture so the second POST reliably lands while the first seed is still running.
  const seeder = newSeeder(40_000);
  await seeder.init();
  const runner = idleRunner(seeder);
  const app = createApp({ seeder, runner });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app).listen(0, () => resolve(s));
  });
  const hub = attachWebSocket(server, seeder, runner);
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
  const runner = idleRunner(seeder);
  const app = createApp({ seeder, runner });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app).listen(0, () => resolve(s));
  });
  const hub = attachWebSocket(server, seeder, runner);
  const { port } = server.address() as AddressInfo;

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: Array<{ t: string; percent: number }> = [];
  socket.on("message", (data: Buffer) => {
    frames.push(JSON.parse(data.toString()) as { t: string; percent: number });
  });

  try {
    await once(socket, "open");
    const done = once(seeder, "done");
    await seeder.start();
    await done;
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

/** Every key in the db with its value and TTL — strings as values, sets as sorted members. */
async function snapshot(): Promise<Map<string, { value: string; ttl: number }>> {
  const out = new Map<string, { value: string; ttl: number }>();
  for (const key of await redis.keys("*")) {
    const type = await redis.type(key);
    const value =
      type === "set" ? JSON.stringify((await redis.smembers(key)).sort()) : ((await redis.get(key)) ?? "");
    out.set(key, { value, ttl: await redis.ttl(key) });
  }
  return out;
}

function seedWith(seedMode: SeedMode, over: Partial<SeederConfig> = {}): Promise<SeedMarker> {
  return seedToReady(newSeeder(SEED_KEYS, SEED_VALUE, { seedMode, ...over }));
}

test("lazy-warm fills the eviction batch through the filler after a bulk seed, byte-identical to the generator", async () => {
  const { filler, originCalls } = fakeChain();
  const seeder = new Seeder(redis as unknown as SeederRedis, index, filler, seederConfig({ lazyWarmUsers: 30 }));
  const phases: string[] = [];
  seeder.on("progress", (frame: SeedProgressFrame) => {
    if (frame.phase !== undefined && phases.at(-1) !== frame.phase) phases.push(frame.phase);
  });
  await seedToReady(seeder);

  assert.deepEqual(phases, ["bulk", "lazy-warm"]);
  const warm = [...generateUsers(SEED_KEYS, SEED_VALUE, (u) => index.indexKeyFor(TENANT, CATEGORY, u))].slice(0, 30);
  // Every warm record was requested exactly once, and no other user was.
  assert.equal(originCalls.length, warm.reduce((n, u) => n + u.records.length, 0));
  assert.deepEqual([...new Set(originCalls)].sort(), warm.map((u) => u.userId));
  for (const user of warm) {
    for (const { cacheKey, value } of user.records) {
      assert.equal(await redis.get(cacheKey), value, cacheKey);
      assert.ok((await redis.smembers(user.indexKey)).includes(cacheKey));
    }
  }
});

test("bulk and lazy seeds of the same SEED_VALUE account for the same keys, values and TTLs", async () => {
  const bulkMarker = await seedWith("bulk");
  const bulk = await snapshot();
  await redis.flushdb();
  const lazyMarker = await seedWith("lazy");
  const lazy = await snapshot();

  assert.equal(lazyMarker.seedMode, "lazy");
  assert.deepEqual(
    { c: lazyMarker.cacheKeys, i: lazyMarker.indexKeys },
    { c: bulkMarker.cacheKeys, i: bulkMarker.indexKeys },
  );
  assert.equal(lazy.size, bulk.size);
  for (const [key, b] of bulk) {
    if (key === MARKER_KEY) continue;
    const l = lazy.get(key);
    assert.ok(l, `lazy seed is missing ${key}`);
    assert.equal(l.value, b.value, key);
    assert.ok(Math.abs(l.ttl - b.ttl) <= 2 && l.ttl > 0, `${key} ttl bulk ${b.ttl} lazy ${l.ttl}`);
  }
});

test("lazy refuses above LAZY_MAX_KEYS, naming the flag, before touching the existing fixture", async () => {
  const seeder = newSeeder(SEED_KEYS, SEED_VALUE, { lazyMaxKeys: 1000 });
  await seedToReady(seeder);
  const dbsize = await redis.dbsize();

  await assert.rejects(seeder.start({ seedMode: "lazy", seedKeys: 2_000_000 }), (err: unknown) => {
    assert.ok(err instanceof SeedRefusedError);
    assert.match(err.message, /LAZY_MAX_KEYS=1000/);
    return true;
  });
  assert.equal((await seeder.status()).state, "ready");
  assert.equal(await redis.dbsize(), dbsize);
});

test("an origin failure during a lazy fill caches nothing for that user and the seed still completes", async () => {
  const failUser = "u_0000002";
  const { filler } = fakeChain({ failUser });
  const seeder = new Seeder(redis as unknown as SeederRedis, index, filler, seederConfig());
  const marker = await seedToReady(seeder);

  const totals = expectedTotals(SEED_KEYS, SEED_VALUE);
  const failedRecords = marker.originFailures;
  assert.ok(failedRecords >= 1 && failedRecords <= 3, `originFailures ${failedRecords}`);
  assert.equal(marker.cacheKeys, totals.cacheKeys - failedRecords);
  assert.equal(marker.indexKeys, totals.indexKeys - 1);
  assert.deepEqual(await redis.keys(`*${failUser}*`), []);
  assert.equal(await redis.dbsize(), marker.cacheKeys + marker.indexKeys + 1);
  assert.equal((await seeder.status()).originFailures, failedRecords);
});

test("HTTP: POST /api/seed accepts seedMode/seedKeys overrides and 400s a refused or malformed one", async () => {
  const seeder = newSeeder(SEED_KEYS, SEED_VALUE, { lazyMaxKeys: 1000 });
  const runner = idleRunner(seeder);
  const server: Server = await new Promise((resolve) => {
    const s = createServer(createApp({ seeder, runner })).listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const post = (body: unknown): Promise<globalThis.Response> =>
    fetch(`http://127.0.0.1:${port}/api/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    const refused = await post({ seedMode: "lazy", seedKeys: 2_000_000 });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /LAZY_MAX_KEYS/);
    assert.equal((await post({ seedMode: "eager" })).status, 400);
    assert.equal((await post({ seedKeys: 1.5 })).status, 400);

    assert.equal((await post({ seedMode: "lazy", seedKeys: 200 })).status, 202);
    assert.equal(await waitSettled(seeder), "ready");
    const status = await seeder.status();
    assert.equal(status.seedMode, "lazy");
    assert.equal(status.targetKeys, 200);
    assert.equal(status.phase, "lazy-warm");
  } finally {
    await closeServer(server);
  }
});

test("a SEED_VALUE mismatch with mock-billing refuses the seed, naming both values, before touching the fixture", async () => {
  const seeder = newSeeder();
  await seedToReady(seeder);
  const dbsize = await redis.dbsize();

  const { filler, originCalls } = fakeChain({ originSeedValue: 2 });
  const mismatched = new Seeder(redis as unknown as SeederRedis, index, filler, seederConfig());
  await mismatched.init();
  await assert.rejects(mismatched.start(), (err: unknown) => {
    assert.ok(err instanceof SeedRefusedError);
    assert.match(err.message, /mock-billing SEED_VALUE=2/);
    assert.match(err.message, /benchmark SEED_VALUE=1/);
    return true;
  });
  assert.deepEqual(originCalls, [], "no lazy request was made");
  assert.equal((await mismatched.status()).state, "ready", "the loaded fixture is still reported ready");
  assert.equal(await redis.dbsize(), dbsize);

  // An unreachable origin refuses too; a bulk seed with no lazy-warm users never asks.
  const unreachable: LazyFiller = { ...filler, originSeedValue: () => Promise.reject(new Error("ECONNREFUSED")) };
  await assert.rejects(
    new Seeder(redis as unknown as SeederRedis, index, unreachable, seederConfig()).start(),
    /cannot read mock-billing's SEED_VALUE.*ECONNREFUSED/,
  );
  const bulkOnly = new Seeder(redis as unknown as SeederRedis, index, unreachable, seederConfig({ lazyWarmUsers: 0 }));
  await seedToReady(bulkOnly);
});

test("HTTP: POST /api/seed answers 400 with the SEED_VALUE mismatch", async () => {
  const seeder = new Seeder(redis as unknown as SeederRedis, index, fakeChain({ originSeedValue: 7 }).filler, seederConfig());
  const server: Server = await new Promise((resolve) => {
    const s = createServer(createApp({ seeder, runner: idleRunner(seeder) })).listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/seed`, { method: "POST" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /SEED_VALUE=7.*SEED_VALUE=1/);
    assert.equal((await seeder.status()).state, "idle");
  } finally {
    await closeServer(server);
  }
});
