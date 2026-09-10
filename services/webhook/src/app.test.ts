import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import Redis from "ioredis";
import { EntityIndex, type RedisClient } from "@redis-hash-index/cache";
import { createApp, type Job, type WebhookRedis } from "./app";

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
  const app = createApp(redis as unknown as WebhookRedis);
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

function userId(i: number): string {
  return `u_${String(i).padStart(7, "0")}`;
}

function indexKey(id: string): string {
  return `entityIndex::demo::activeSubscription::${id}`;
}

async function seedUser(id: string, variants: number): Promise<void> {
  for (let v = 1; v <= variants; v += 1) {
    const key = `test-api::demo::activeSubscription::${id}::{"v":${v}}`;
    await redis.set(key, JSON.stringify({ userId: id, planId: "pro-monthly" }), "EX", 3600);
    await index.register(key, 3600);
  }
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function pollUntilTerminal(jobId: string): Promise<Job> {
  for (let i = 0; i < 250; i += 1) {
    const res = await fetch(`${baseUrl}/jobs/${jobId}`);
    assert.equal(res.status, 200);
    const job = (await res.json()) as Job;
    if (job.state !== "running") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`job ${jobId} never reached a terminal state`);
}

test("GET /health returns {ok:true}", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("v1 and v2 remove every cache key for their disjoint user groups", async () => {
  await redis.flushdb();

  // ~80 users, 1..3 variants each — roughly 200 cache keys.
  const groupV1 = Array.from({ length: 40 }, (_, i) => userId(i + 1));
  const groupV2 = Array.from({ length: 40 }, (_, i) => userId(i + 41));
  for (const [n, id] of [...groupV1, ...groupV2].entries()) {
    await seedUser(id, 1 + (n % 3));
  }
  // An unrelated user, outside every batch, that must survive untouched.
  const bystander = userId(9999);
  await seedUser(bystander, 3);

  const startV1 = await post("/v1/invalidate", { userIds: groupV1 });
  assert.equal(startV1.status, 202);
  const v1Body = (await startV1.json()) as { jobId: string; mode: string; total: number };
  assert.equal(v1Body.mode, "v1");
  assert.equal(v1Body.total, 40);

  const startV2 = await post("/v2/invalidate", { userIds: groupV2 });
  assert.equal(startV2.status, 202);
  const v2Body = (await startV2.json()) as { jobId: string; mode: string; total: number };
  assert.equal(v2Body.mode, "v2");
  assert.equal(v2Body.total, 40);

  const v1Job = await pollUntilTerminal(v1Body.jobId);
  const v2Job = await pollUntilTerminal(v2Body.jobId);
  assert.equal(v1Job.state, "done");
  assert.equal(v2Job.state, "done");
  assert.equal(v1Job.processed, 40);
  assert.equal(v2Job.processed, 40);
  assert.ok(v1Job.removed >= 40);
  assert.ok(v2Job.removed >= 40);

  // Every cache key for both groups is gone.
  for (const id of [...groupV1, ...groupV2]) {
    assert.deepEqual(await redis.keys(`*::${id}::*`), [], `cache keys left for ${id}`);
  }
  // Every index key for the v2 group is gone (v2 SREMs every member, emptying the set).
  for (const id of groupV2) {
    assert.equal(await redis.exists(indexKey(id)), 0, `index key left for ${id}`);
  }
  // The bystander is untouched — catches an over-broad KEYS pattern.
  assert.equal((await redis.keys(`*::${bystander}::*`)).length, 3);
  assert.equal(await redis.exists(indexKey(bystander)), 1);
});

test("POST /jobs/:id/stop aborts a running job between users", async () => {
  // IDs 5000..8999 — none are seeded, so this job touches no real fixture data.
  const many = Array.from({ length: 4000 }, (_, i) => userId(i + 5000));

  const start = await post("/v1/invalidate", { userIds: many });
  assert.equal(start.status, 202);
  const { jobId } = (await start.json()) as { jobId: string };

  const stop = await post(`/jobs/${jobId}/stop`);
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { jobId, state: "stopped" });

  const job = await pollUntilTerminal(jobId);
  assert.equal(job.state, "stopped");
  assert.ok(job.processed < job.total, `processed ${job.processed} should be < ${job.total}`);
});

test("bad request bodies are rejected with 400", async () => {
  for (const mode of ["v1", "v2"]) {
    assert.equal((await post(`/${mode}/invalidate`, {})).status, 400);
    assert.equal((await post(`/${mode}/invalidate`, { userIds: [] })).status, 400);
    assert.equal((await post(`/${mode}/invalidate`, { userIds: ["nope"] })).status, 400);
  }
});

test("GET /jobs/:id and stop return 404 for an unknown job", async () => {
  assert.equal((await fetch(`${baseUrl}/jobs/job_missing`)).status, 404);
  assert.equal((await post("/jobs/job_missing/stop")).status, 404);
});
