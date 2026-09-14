import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { EntityIndexCacheStrategy, type RedisClient } from "@redis-hash-index/cache";
import { recordOrdinalFor, recordsFor, userIdFor } from "@redis-hash-index/fixture";
import express, { type Express } from "express";
import Redis from "ioredis";
import { WebSocket } from "ws";

import { createApp } from "./app";
import { CACHE_TTL_SECONDS, CATEGORY, TENANT } from "./config";
import { RunInProgressError, Runner, type RunnerConfig } from "./runner";
import { Seeder, type LazyFiller, type SeederRedis } from "./seeder";
import { attachWebSocket } from "./ws";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
// DB 14, not 15: Node's test runner runs test files in parallel child processes, and seeder.test.ts
// flushes DB 15 in its beforeEach — sharing it would wipe this suite's fixture mid-run.
const TEST_DB = 14;
const SEED_KEYS = 50_000;
const SEED_VALUE = 1;

const redis = new Redis(REDIS_URL, { db: TEST_DB });
const index = new EntityIndexCacheStrategy(redis as unknown as RedisClient, { categories: [CATEGORY] });

// Stands in for test-api → mock-billing in the lazy-warm phase: writes each record the way test-api's
// @Cache does. seeder.test.ts documents where the real chain is tested.
const filler: LazyFiller = {
  originSeedValue: () => Promise.resolve(SEED_VALUE),
  fill: async (userId, variant) => {
    const i = Number(userId.slice(2));
    const record = recordsFor(i, SEED_VALUE, recordOrdinalFor(i, SEED_VALUE))[variant - 1];
    if (record === undefined) throw new Error(`no record for ${userId} v${variant}`);
    await index.registerMany([{ ...record, ttlSeconds: CACHE_TTL_SECONDS }]);
  },
};

const seeder = new Seeder(
  redis as unknown as SeederRedis,
  index,
  filler,
  {
    seedKeys: SEED_KEYS,
    seedValue: SEED_VALUE,
    pipelineSize: 20_000,
    seedMode: "bulk",
    lazyConcurrency: 16,
    lazyMaxKeys: 50_000,
    lazyWarmUsers: 1000,
  },
);

function runnerConfig(over: Partial<RunnerConfig>): RunnerConfig {
  return {
    testApiBaseUrl: "http://127.0.0.1:1",
    webhookBaseUrl: "http://127.0.0.1:1",
    pollIntervalMs: 150,
    batchDelayMs: 200,
    batchUsers: 40,
    pollTimeoutMs: 4000,
    historyCap: 3600,
    ...over,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${message}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A stand-in for test-api's `?fill=false` probe: SMEMBERS then MGET, exactly like the real one. */
function fakeTestApi(): Express {
  const app = express();
  app.get("/subscription/:userId", (req, res) => {
    const userId = req.params.userId;
    if (req.query.fill !== "false") {
      res.status(500).json({ error: "the run driver must poll with fill=false" });
      return;
    }
    const key = index.indexKeyFor(TENANT, CATEGORY, userId);
    void (async () => {
      const members = await redis.smembers(key);
      const values = members.length > 0 ? await redis.mget(members) : [];
      const hit = values.some((v) => v !== null);
      res.json({
        userId,
        source: hit ? "cache" : "miss",
        hit,
        variants: values.filter((v) => v !== null).length,
        latencyMs: 0.2,
      });
    })();
  });
  return app;
}

interface FakeJob {
  jobId: string;
  mode: string;
  state: string;
  total: number;
  processed: number;
  removed: number;
  finishedAt: string | null;
  incomplete: unknown[];
}

/** A stand-in for webhook's v2 path: delegates to packages/cache, checks the stop flag between users. */
function fakeWebhook(): Express {
  const jobs = new Map<string, FakeJob>();
  const app = express();
  app.use(express.json());
  app.post("/v2/invalidate", (req, res) => {
    const userIds = (req.body as { userIds: string[] }).userIds;
    const job: FakeJob = {
      jobId: `job_${randomBytes(4).toString("hex")}`,
      mode: "v2",
      state: "running",
      total: userIds.length,
      processed: 0,
      removed: 0,
      finishedAt: null,
      incomplete: [],
    };
    jobs.set(job.jobId, job);
    void (async () => {
      for (const userId of userIds) {
        if (job.state === "stopped") break;
        const one = await index.invalidateEntities(TENANT, CATEGORY, [userId]);
        job.processed += 1;
        job.removed += one.valuesUnlinked;
      }
      if (job.state === "running") job.state = "done";
      job.finishedAt = new Date().toISOString();
    })();
    res.status(202).json({ jobId: job.jobId, mode: "v2", total: job.total });
  });
  app.get("/jobs/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (job === undefined) {
      res.status(404).json({ error: "no such job" });
      return;
    }
    res.json(job);
  });
  app.post("/jobs/:jobId/stop", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (job === undefined) {
      res.status(404).json({ error: "no such job" });
      return;
    }
    if (job.state === "running") job.state = "stopped";
    res.json({ jobId: job.jobId, state: job.state });
  });
  return app;
}

before(async () => {
  await redis.flushdb();
  // Resolve on `done`, reject on `failed` — never hang the suite waiting on an event that won't fire.
  await new Promise<void>((resolve, reject) => {
    seeder.once("done", () => resolve());
    seeder.once("failed", (msg: string) => reject(new Error(`seed failed: ${msg}`)));
    seeder.start().catch(reject);
  });
});

after(async () => {
  await redis.quit();
});

test("a v2 run polls test-api, dispatches the batch, and streams samples with job counters", async () => {
  const testApi = createServer(fakeTestApi());
  const webhook = createServer(fakeWebhook());
  const testApiUrl = await listen(testApi);
  const webhookUrl = await listen(webhook);

  const runner = new Runner(
    seeder,
    runnerConfig({ testApiBaseUrl: testApiUrl, webhookBaseUrl: webhookUrl, batchUsers: 40 }),
  );
  const frames: Array<Record<string, unknown>> = [];
  runner.on("frame", (f: Record<string, unknown>) => frames.push(f));

  try {
    const start = runner.start("v2");
    assert.match(start.runId, /^run_/);
    assert.equal(start.mode, "v2");

    assert.throws(() => runner.start("v2"), RunInProgressError);

    await waitFor(() => frames.some((f) => f.t === "batch"), "batch frame");
    const batch = frames.find((f) => f.t === "batch") as { webhookJobId: string; count: number };
    assert.equal(batch.count, 40);

    await waitFor(async () => {
      const job = (await (await fetch(`${webhookUrl}/jobs/${batch.webhookJobId}`)).json()) as {
        state: string;
      };
      return job.state === "done";
    }, "webhook v2 job done");

    // let a couple more polls land so at least one sample carries the finished job counters
    await delay(400);
    const stop = await runner.stop();
    assert.equal(stop.stopped, true);

    const samples = frames.filter((f) => f.t === "sample");
    assert.ok(samples.length >= 2, `expected >=2 samples, got ${samples.length}`);
    for (const s of samples) {
      assert.equal(typeof s.latencyMs, "number");
      assert.equal(s.runId, start.runId);
    }
    assert.ok(
      samples.some((s) => {
        const job = s.job as { state?: string } | null;
        return job !== null && job.state === "done";
      }),
      "expected a sample carrying the completed webhook job",
    );
    assert.ok(frames.some((f) => f.t === "run-started"));
    assert.ok(frames.some((f) => f.t === "run-stopped"));

    // the batch users' cache keys are gone (v2 emptied their index sets)
    const members = await redis.smembers(index.indexKeyFor(TENANT, CATEGORY, userIdFor(0)));
    assert.equal(members.length, 0);
  } finally {
    await runner.stop();
    runner.removeAllListeners();
    await closeServer(testApi);
    await closeServer(webhook);
  }
});

test("a v2 run emits exactly one batch-completed frame at the job's finishedAt, and keeps polling", async () => {
  const testApi = createServer(fakeTestApi());
  const webhook = createServer(fakeWebhook());
  const testApiUrl = await listen(testApi);
  const webhookUrl = await listen(webhook);

  const runner = new Runner(
    seeder,
    runnerConfig({ testApiBaseUrl: testApiUrl, webhookBaseUrl: webhookUrl, batchUsers: 40 }),
  );
  const frames: Array<Record<string, unknown>> = [];
  runner.on("frame", (f: Record<string, unknown>) => frames.push(f));

  try {
    const start = runner.start("v2");
    await waitFor(() => frames.some((f) => f.t === "batch-completed"), "batch-completed frame");
    const completedIdx = frames.findIndex((f) => f.t === "batch-completed");
    const completed = frames[completedIdx] as Record<string, unknown>;
    const batch = frames.find((f) => f.t === "batch") as { webhookJobId: string; ts: number; elapsedSec: number };
    const job = (await (await fetch(`${webhookUrl}/jobs/${batch.webhookJobId}`)).json()) as {
      finishedAt: string;
      removed: number;
    };
    const started = frames.find((f) => f.t === "run-started") as { ts: number };

    assert.equal(completed.runId, start.runId);
    assert.equal(completed.mode, "v2");
    assert.equal(completed.state, "done");
    assert.equal(completed.ts, Date.parse(job.finishedAt), "ts is the job's finishedAt, not the poll's");
    assert.equal(completed.elapsedSec, Math.round((completed.ts as number) - started.ts) / 1000);
    assert.equal(batch.elapsedSec, Math.round(batch.ts - started.ts) / 1000, "dispatch is fractional too");
    assert.ok((completed.elapsedSec as number) >= batch.elapsedSec, "completion never precedes dispatch");
    // removed is whatever the job reports — the earlier test already evicted these users from DB 14
    assert.deepEqual(
      [completed.processed, completed.total, completed.removed, completed.incomplete],
      [40, 40, job.removed, 0],
    );

    // polling continues after completion, and later polls do not emit a second marker
    const samplesAtCompletion = frames.filter((f) => f.t === "sample").length;
    await waitFor(
      () => frames.filter((f) => f.t === "sample").length >= samplesAtCompletion + 3,
      "samples after completion",
    );
    assert.equal(runner.isRunning(), true, "the run does not auto-stop");

    const history = runner.historyFrame();
    assert.equal(history?.completedAt, completed.ts);
    assert.equal(history?.completionState, "done");
    assert.deepEqual(history?.completion, { processed: 40, total: 40, removed: completed.removed, incomplete: 0 });

    await runner.stop();
    assert.equal(frames.filter((f) => f.t === "batch-completed").length, 1);
  } finally {
    await runner.stop();
    runner.removeAllListeners();
    await closeServer(testApi);
    await closeServer(webhook);
  }
});

test("stop() aborts the run and calls the webhook stop endpoint", async () => {
  const testApi = createServer(fakeTestApi());
  const webhook = createServer(fakeWebhook());
  const testApiUrl = await listen(testApi);
  const webhookUrl = await listen(webhook);

  // A big batch so the v2 job is still running when we stop it a fraction of a second later.
  const runner = new Runner(
    seeder,
    runnerConfig({
      testApiBaseUrl: testApiUrl,
      webhookBaseUrl: webhookUrl,
      batchUsers: 2000,
      batchDelayMs: 100,
    }),
  );
  const frames: Array<Record<string, unknown>> = [];
  runner.on("frame", (f: Record<string, unknown>) => frames.push(f));

  try {
    runner.start("v2");
    await waitFor(() => frames.some((f) => f.t === "batch"), "batch frame");
    const batch = frames.find((f) => f.t === "batch") as { webhookJobId: string };

    const stop = await runner.stop();
    assert.equal(stop.webhookJobId, batch.webhookJobId);
    assert.ok(["stopped", "done"].includes(stop.webhookState ?? ""));
    assert.equal(runner.isRunning(), false);

    const job = (await (await fetch(`${webhookUrl}/jobs/${batch.webhookJobId}`)).json()) as {
      state: string;
      processed: number;
      total: number;
    };
    assert.ok(["stopped", "done"].includes(job.state));
    if (job.state === "stopped") assert.ok(job.processed < job.total);

    // Stop ends polling, so stop() itself reports the completion — before run-stopped.
    const completedIdx = frames.findIndex((f) => f.t === "batch-completed");
    const stoppedIdx = frames.findIndex((f) => f.t === "run-stopped");
    assert.ok(completedIdx >= 0 && completedIdx < stoppedIdx, "batch-completed precedes run-stopped");
    const completed = frames[completedIdx] as Record<string, unknown>;
    assert.equal(completed.state, job.state);
    assert.equal(completed.processed, job.processed);
    assert.equal(completed.total, 2000);
  } finally {
    await runner.stop();
    runner.removeAllListeners();
    await closeServer(testApi);
    await closeServer(webhook);
  }
});

test("HTTP: POST /api/run is 202, a second is 409, and a mid-run /ws client gets a history frame", async () => {
  const testApi = createServer(fakeTestApi());
  const webhook = createServer(fakeWebhook());
  const testApiUrl = await listen(testApi);
  const webhookUrl = await listen(webhook);

  const runner = new Runner(
    seeder,
    runnerConfig({ testApiBaseUrl: testApiUrl, webhookBaseUrl: webhookUrl, batchUsers: 20 }),
  );
  const app = createApp({ seeder, runner });
  const server: Server = createServer(app);
  const base = await listen(server);
  const hub = attachWebSocket(server, seeder, runner);
  const { port } = server.address() as AddressInfo;

  try {
    const started = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "v2" }),
    });
    assert.equal(started.status, 202);
    const startBody = (await started.json()) as { runId: string };
    assert.match(startBody.runId, /^run_/);

    const rejected = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "v1" }),
    });
    assert.equal(rejected.status, 409);

    // wait for at least one sample so the history frame is non-trivial
    await waitFor(() => (runner.historyFrame()?.samples.length ?? 0) >= 1, "a sample recorded");

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: Array<{ t: string; samples?: unknown[] }> = [];
    socket.on("message", (data: Buffer) => {
      frames.push(JSON.parse(data.toString()) as { t: string });
    });
    await once(socket, "open");
    await waitFor(() => frames.some((f) => f.t === "history"), "history frame on connect");
    const history = frames.find((f) => f.t === "history");
    assert.ok(Array.isArray(history?.samples) && history.samples.length >= 1);
    socket.terminate();

    const stopped = await fetch(`${base}/api/run/stop`, { method: "POST" });
    assert.equal(stopped.status, 200);
    const stopBody = (await stopped.json()) as { stopped: boolean };
    assert.equal(stopBody.stopped, true);
    assert.equal(runner.isRunning(), false);

    const badMode = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "nope" }),
    });
    assert.equal(badMode.status, 400);
  } finally {
    await runner.stop();
    await hub.close();
    await closeServer(server);
    await closeServer(testApi);
    await closeServer(webhook);
  }
});
