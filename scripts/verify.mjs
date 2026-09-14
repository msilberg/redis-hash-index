#!/usr/bin/env node
// make verify — the one command a stranger runs to find out whether this repo is honest.
//
//   1. docker compose up -d --build, wait for every healthcheck
//   2. seed SEED_KEYS (default 50000), poll /api/seed/status until ready
//   3. capture DBSIZE and the batch users' key count
//   4. start a v2 run, wait for the webhook job to reach done
//   5. assert: every cache key AND index key for the batch users is gone,
//              an untouched control user still has its keys,
//              DBSIZE dropped by exactly the number of keys those users owned
//   6. take a bulk-seeded user, invalidate it, refill it through test-api -> mock-billing, and
//      assert every stored value is byte-identical to what the bulk writer wrote
//   7. docker compose down -v (always, even on failure)
//
// Exits non-zero on any failure. A verify script that always passes is worse than none.

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const SEED_KEYS = process.env.SEED_KEYS ?? "50000";
const BASE = "http://localhost:3000";
const WEBHOOK = "http://localhost:3002";
const TEST_API = "http://localhost:3001";

// The eviction batch is userIdFor(0 .. BATCH_USERS-1); default BATCH_USERS is 1000.
const BATCH_USERS = Number(process.env.BATCH_USERS ?? "1000");

const log = (m) => console.error(`\n=== ${m}`);

let downDone = false;
function down() {
  if (downDone) return;
  downDone = true;
  log("docker compose down -v");
  try {
    compose("down", "-v");
  } catch {
    /* best effort */
  }
}
function die(msg) {
  console.error(`\nVERIFY FAILED: ${msg}`);
  down();
  process.exit(1);
}
process.on("SIGINT", () => {
  down();
  process.exit(130);
});

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}
const compose = (...args) => sh("docker", ["compose", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const composeOut = (...args) => sh("docker", ["compose", ...args]);
const redis = (...args) =>
  sh("docker", ["compose", "exec", "-T", "redis", "redis-cli", ...args]).trim();

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}
async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ids = composeOut("ps", "-q").trim().split("\n").filter(Boolean);
    const rows = sh("docker", [
      "inspect",
      "--format",
      "{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}",
      ...ids,
    ]).trim();
    const bad = rows.split("\n").filter((r) => !/(healthy|no-healthcheck)$/.test(r));
    if (bad.length === 0) {
      console.error(rows);
      return;
    }
    if (Date.now() > deadline) die(`containers not healthy in time:\n${rows}`);
    await sleep(3000);
  }
}

async function waitSeedReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await getJson(`${BASE}/api/seed/status`);
    if (status.state === "ready") return status;
    if (status.state === "failed") die(`seed failed: ${JSON.stringify(status)}`);
    if (Date.now() > deadline) die(`seed did not reach ready in time (last: ${JSON.stringify(status)})`);
    await sleep(2000);
  }
}

// Watch /ws until the run driver dispatches the batch, and return its webhook job id.
function waitBatchJobId(timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no batch frame within timeout"));
    }, timeoutMs);
    const finish = (fn, arg) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn(arg);
    };
    ws.addEventListener("message", (ev) => {
      let f;
      try {
        f = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if ((f.t === "batch" || f.t === "history") && f.webhookJobId) finish(resolve, f.webhookJobId);
      else if (f.t === "batch-error") finish(reject, new Error(`batch dispatch failed: ${f.error}`));
    });
    ws.addEventListener("error", () => {
      /* the message/timeout paths own the outcome */
    });
  });
}

async function waitJobDone(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJson(`${WEBHOOK}/jobs/${jobId}`);
    if (job.state === "done") return job;
    if (job.state === "failed") throw new Error(`webhook job failed: ${JSON.stringify(job)}`);
    if (Date.now() > deadline) throw new Error(`webhook job did not finish in time: ${JSON.stringify(job)}`);
    await sleep(1000);
  }
}

// Count the fixture keys owned by a contiguous block of users [0, count).
function keyCensus(count) {
  const idxKeys = [];
  for (let i = 0; i < count; i += 1) {
    idxKeys.push(`entityIndex::demo::activeSubscription::u_${String(i).padStart(7, "0")}`);
  }
  // redis-cli EXISTS k1 k2 ... returns how many of the listed keys exist.
  const indexPresent = Number(redis("exists", ...idxKeys));

  // Cache keys have an opaque params tail, so enumerate them. u_0000000..u_00000NN share the
  // prefix u_00000; a bracket class pins the last three digits without over-matching.
  const digits = String(count - 1).length;
  const prefix = "u_" + "0".repeat(7 - digits);
  const pattern = `test-api::demo::activeSubscription::${prefix}${"[0-9]".repeat(digits)}::*`;
  const out = redis("--scan", "--pattern", pattern);
  const cachePresent = out === "" ? 0 : out.split("\n").filter(Boolean).length;

  return { indexPresent, cachePresent, total: indexPresent + cachePresent };
}

async function main() {
  process.env.SEED_KEYS = SEED_KEYS;

  log(`1/7  docker compose up -d --build (SEED_KEYS=${SEED_KEYS})`);
  compose("up", "-d", "--build");
  log("waiting for every container to report healthy");
  await waitHealthy(240_000);

  log(`2/7  seed SEED_KEYS=${SEED_KEYS} and wait for ready`);
  await postJson(`${BASE}/api/seed`);
  const status = await waitSeedReady(240_000);
  console.error(JSON.stringify(status));

  const batchUsers = Math.min(BATCH_USERS, status.users);
  if (batchUsers <= 0) die("seed reported zero users");
  const controlId = `u_${String(status.users - 1).padStart(7, "0")}`; // last seeded user, never in the batch

  log("3/7  capture DBSIZE and the batch users' key census");
  const dbBefore = Number(redis("dbsize"));
  const before = keyCensus(batchUsers);
  console.error(
    `DBSIZE ${dbBefore}; batch users 0..${batchUsers - 1} own ${before.cachePresent} cache + ${before.indexPresent} index keys`,
  );
  if (before.total === 0) die("the batch users own no keys before the run — fixture is wrong");
  if (before.indexPresent !== batchUsers) die(`expected ${batchUsers} index keys, found ${before.indexPresent}`);

  // fill=false: the probe reads the cache and never refills it — a filling read would hide an eviction.
  const control = await getJson(`${TEST_API}/subscription/${controlId}?fill=false`);
  if (!control.hit) die(`control user ${controlId} has no cache hit before the run: ${JSON.stringify(control)}`);

  log("4/7  start a v2 run and wait for the webhook job to reach done");
  const run = await postJson(`${BASE}/api/run`, { mode: "v2" });
  console.error(`run: ${JSON.stringify(run)}`);
  const jobId = await waitBatchJobId(60_000);
  const job = await waitJobDone(jobId, 120_000);
  console.error(`webhook job: ${JSON.stringify(job)}`);
  await postJson(`${BASE}/api/run/stop`);

  log("5/7  assert the batch users' keys are gone and the control user survives");
  const after = keyCensus(batchUsers);
  if (after.total !== 0) {
    die(
      `batch users still own keys after v2: ${after.cachePresent} cache + ${after.indexPresent} index`,
    );
  }
  const controlAfter = await getJson(`${TEST_API}/subscription/${controlId}?fill=false`);
  if (!controlAfter.hit || controlAfter.variants < 1) {
    die(`control user ${controlId} lost its cache: ${JSON.stringify(controlAfter)}`);
  }

  const dbAfter = Number(redis("dbsize"));
  const drop = dbBefore - dbAfter;
  console.error(`DBSIZE ${dbBefore} -> ${dbAfter} (dropped ${drop}, expected ${before.total})`);
  if (drop !== before.total) {
    die(`DBSIZE dropped by ${drop}, expected exactly ${before.total} (the batch users' keys)`);
  }
  if (job.processed !== batchUsers) die(`webhook processed ${job.processed}, expected ${batchUsers}`);

  log("6/7  refill a bulk-seeded user through test-api -> mock-billing and compare byte for byte");
  // Not the batch (0..batchUsers-1, filled by lazy-warm) and not the control: a bulk-phase user.
  const chainId = `u_${String(Math.floor(status.users / 2)).padStart(7, "0")}`;
  const chainIndex = `entityIndex::demo::activeSubscription::${chainId}`;
  const chainKeys = redis("smembers", chainIndex).split("\n").filter(Boolean).sort();
  if (chainKeys.length === 0) die(`${chainId} has no index members to refill`);
  const bulkValues = new Map(chainKeys.map((key) => [key, redis("get", key)]));

  const chainJob = await postJson(`${WEBHOOK}/v2/invalidate`, { userIds: [chainId] });
  await waitJobDone(chainJob.jobId, 30_000);
  if (Number(redis("exists", ...chainKeys, chainIndex)) !== 0) die(`${chainId} survived its invalidation`);

  for (const key of chainKeys) {
    const variant = /::\{"v":(\d+)\}$/.exec(key)?.[1];
    if (variant === undefined) die(`unexpected params segment in ${key}`);
    const read = await getJson(`${TEST_API}/subscription/${chainId}?v=${variant}`);
    if (read.source !== "origin") die(`refill of ${key} did not reach the origin: ${JSON.stringify(read)}`);
  }
  for (const key of chainKeys) {
    const refilled = redis("get", key);
    if (refilled !== bulkValues.get(key)) {
      die(`${key} differs after the refill\n  bulk:     ${bulkValues.get(key)}\n  refilled: ${refilled}`);
    }
  }
  const refilledKeys = redis("smembers", chainIndex).split("\n").filter(Boolean).sort();
  if (JSON.stringify(refilledKeys) !== JSON.stringify(chainKeys)) {
    die(`${chainId} index after refill ${JSON.stringify(refilledKeys)}, expected ${JSON.stringify(chainKeys)}`);
  }
  console.error(`${chainId}: ${chainKeys.length} values refilled through the chain, byte-identical to the bulk seed`);

  log("7/7  all assertions passed");
  down();
  console.error("\nVERIFY OK");
  process.exit(0);
}

main().catch((err) => die(err instanceof Error ? (err.stack ?? err.message) : String(err)));
