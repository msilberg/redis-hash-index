// The demo's central claim, tested across a real network hop: a record written by the bulk seeder and
// the same record refilled through test-api → mock-billing are byte-identical in Redis.
//
// mock-billing is spawned as its own process (it is a service, not a library — test-api never imports
// its workspace) on an ephemeral port, with the same SEED_VALUE as the bulk writer below.

import {
  buildCacheKey,
  configureCache,
  EntityIndexCacheStrategy,
  TTL,
  type RedisClient,
} from "@redis-hash-index/cache";
import { CATEGORY, recordOrdinalFor, recordsFor, SERVICE, TENANT } from "@redis-hash-index/fixture";
import Redis from "ioredis";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createApp, type RedisReader } from "./app";
import { BillingClient } from "./billing-client";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
// app.test.ts owns DB 15, read-path.test.ts DB 14; test files run in parallel.
const TEST_DB = 13;
const SEED_VALUE = 1;
const USER_INDEX = 4; // u_0000004: three variants at seed 1
const FAIL_USER = "u_0000002";

const redis = new Redis(REDIS_URL, { db: TEST_DB });
const index = new EntityIndexCacheStrategy(redis as unknown as RedisClient, { categories: [CATEGORY] });

let billing: ChildProcess;
let server: Server;
let baseUrl: string;

/** Start mock-billing with PORT=0 and read the port it bound from its startup line. */
async function startMockBilling(): Promise<{ child: ChildProcess; url: string }> {
  const entry = path.join(__dirname, "..", "..", "mock-billing", "src", "index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: { ...process.env, PORT: "0", SEED_VALUE: String(SEED_VALUE), ORIGIN_FAIL_USER: FAIL_USER },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock-billing did not start: ${out}`)), 20_000);
    child.once("exit", (code) => reject(new Error(`mock-billing exited ${code}: ${out}`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening on :(\d+)/.exec(out);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

before(async () => {
  const started = await startMockBilling();
  billing = started.child;
  configureCache({ redis: redis as unknown as RedisClient, service: SERVICE, tenant: TENANT, categories: [CATEGORY] });
  const app = createApp(redis as unknown as RedisReader, new BillingClient({ baseUrl: started.url, timeoutMs: 5000 }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await redis.flushdb();
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const exited = once(billing, "exit");
  billing.kill("SIGTERM");
  await exited;
  await redis.quit();
});

async function getSubscription(pathAndQuery: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/subscription/${pathAndQuery}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("bulk seed → invalidate → refill through mock-billing stores byte-identical values", async () => {
  // Exactly what the benchmark's bulk writer does for this user.
  const records = recordsFor(USER_INDEX, SEED_VALUE, recordOrdinalFor(USER_INDEX, SEED_VALUE));
  assert.equal(records.length, 3);
  await index.registerMany(records.map((record) => ({ ...record, ttlSeconds: TTL.MEDIUM })));
  const userId = `u_${String(USER_INDEX).padStart(7, "0")}`;
  const indexKey = index.indexKeyFor(TENANT, CATEGORY, userId);
  const bulk = new Map<string, string | null>();
  for (const { cacheKey } of records) bulk.set(cacheKey, await redis.get(cacheKey));
  const bulkMembers = (await redis.smembers(indexKey)).sort();

  const invalidation = await index.invalidateEntities(TENANT, CATEGORY, [userId]);
  assert.deepEqual(invalidation.incomplete, []);
  assert.equal(await redis.dbsize(), 0);

  for (let v = 1; v <= records.length; v += 1) {
    const { status, body } = await getSubscription(`${userId}?v=${v}&include_addons=true&utm_source=x`);
    assert.equal(status, 200);
    assert.equal(body.source, "origin", `v=${v} must be a miss after the invalidation`);
  }

  for (const [cacheKey, bulkValue] of bulk) {
    // The route's key is the bulk seeder's key: stray query parameters never reached `params`.
    assert.equal(await redis.get(cacheKey), bulkValue, `refilled ${cacheKey} differs from the bulk value`);
    const ttl = await redis.ttl(cacheKey);
    assert.ok(ttl > TTL.MEDIUM - 5 && ttl <= TTL.MEDIUM, `${cacheKey} ttl ${ttl}`);
  }
  assert.deepEqual((await redis.smembers(indexKey)).sort(), bulkMembers);
  assert.equal(await redis.dbsize(), records.length + 1, "the values and one index set, nothing else");

  assert.equal((await getSubscription(`${userId}?v=2`)).body.source, "cache");
});

test("a 404 from mock-billing is a null subscription and is not cached", async () => {
  const userId = `u_${String(USER_INDEX).padStart(7, "0")}`;
  const { status, body } = await getSubscription(`${userId}?v=4`);
  assert.equal(status, 200);
  assert.equal(body.subscription, null);
  assert.equal(await redis.dbsize(), 0);
  assert.equal((await getSubscription(`${userId}?v=4`)).body.source, "origin");
});

test("a 503 from mock-billing is a 502 and caches nothing", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { status, body } = await getSubscription(`${FAIL_USER}?v=1`);
    assert.equal(status, 502);
    assert.match(String(body.error), /503/);
  }
  assert.equal(await redis.exists(buildCacheKey(SERVICE, TENANT, CATEGORY, [FAIL_USER, { v: 1 }])), 0);
  assert.equal(await redis.dbsize(), 0);
});
