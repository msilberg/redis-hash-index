#!/usr/bin/env node
// make seed — trigger the deterministic fixture seed and stream its progress to the terminal.
//
// `make up` runs this once the stack is healthy, so a single command brings the demo up ready to
// use. It is a no-op when the fixture is already seeded — run `make reset` first, or
// `make seed FORCE=1`, to reseed. Run it standalone to (re)seed a stack that is already up.
//
// Progress comes from polling GET /api/seed/status (no ws dependency). On a TTY it redraws one
// line in place; piped (CI, `make` output captured) it prints a line every few seconds instead.

import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.BENCHMARK_URL ?? "http://localhost:3000";
const FORCE = process.env.FORCE === "1" || process.env.SEED_FORCE === "1";
const POLL_MS = 350;
const TIMEOUT_MS = Number(process.env.SEED_TIMEOUT_MS ?? 20 * 60_000);

const isTTY = process.stdout.isTTY === true;
const fmt = (n) => Math.round(n).toLocaleString("en-US");

async function getStatus() {
  const res = await fetch(`${BASE}/api/seed/status`);
  if (!res.ok) throw new Error(`GET /api/seed/status -> ${res.status}`);
  return res.json();
}

// `make up` calls this the moment the healthcheck passes; give the port a few seconds to answer.
async function waitForBenchmark() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await getStatus();
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`benchmark not reachable at ${BASE}: ${err.message}`);
      await sleep(1000);
    }
  }
}

function bar(percent, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round(percent * width)));
  return "#".repeat(filled) + "-".repeat(width - filled);
}

function totalKeys(status) {
  return (status.cacheKeys ?? 0) + (status.indexKeys ?? 0);
}

function memSuffix(status) {
  return status.memoryHuman && status.memoryHuman !== "0" ? ` · ${status.memoryHuman}` : "";
}

let lastLineLen = 0;
function drawInPlace(line) {
  const pad = " ".repeat(Math.max(0, lastLineLen - line.length));
  process.stdout.write(`\r${line}${pad}`);
  lastLineLen = line.length;
}

function line(status, startedAt) {
  const total = totalKeys(status);
  // `done` counts queued commands, so it can read 100% a beat before the post-seed checks finish —
  // hold at 99% until the server actually flips to `ready`.
  const pct = status.state === "ready" ? 1 : Math.min(0.99, status.progress ?? 0);
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const pctStr = `${Math.round(pct * 100)}`.padStart(3);
  return `  seeding  [${bar(pct)}] ${pctStr}%   ${fmt(total * pct)} / ${fmt(total)} keys${memSuffix(status)}  ${secs}s`;
}

process.on("SIGINT", () => {
  process.stdout.write("\n  interrupted — the seed keeps running in the container; `make seed` to re-attach\n");
  process.exit(130);
});

async function main() {
  let status = await waitForBenchmark();

  if (status.state === "seeding") {
    console.error("  a seed is already running — attaching to its progress");
  } else if (status.state === "ready" && !FORCE) {
    console.error(`  fixture already seeded: ${fmt(totalKeys(status))} keys${memSuffix(status)}  (make reset to reseed)`);
    return;
  } else {
    const res = await fetch(`${BASE}/api/seed`, { method: "POST" });
    // 409 = a seed started between our status read and this POST — fine, just follow its progress.
    if (!res.ok && res.status !== 409) throw new Error(`POST /api/seed -> ${res.status}`);
  }

  const startedAt = Date.now();
  const deadline = startedAt + TIMEOUT_MS;
  let lastPrint = 0;

  for (;;) {
    status = await getStatus();

    if (status.state === "failed") {
      if (isTTY) process.stdout.write("\n");
      throw new Error(`seed failed: ${status.error ?? "unknown error"}`);
    }
    if (status.state === "ready") {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      const done = `  seeded   ${fmt(totalKeys(status))} keys${memSuffix(status)}  in ${secs}s`;
      process.stdout.write(isTTY ? `\r${done}${" ".repeat(Math.max(0, lastLineLen - done.length))}\n` : `${done}\n`);
      return;
    }

    const now = Date.now();
    if (isTTY) {
      drawInPlace(line(status, startedAt));
    } else if (now - lastPrint >= 3000) {
      process.stdout.write(`${line(status, startedAt)}\n`);
      lastPrint = now;
    }

    if (now > deadline) {
      if (isTTY) process.stdout.write("\n");
      throw new Error(`seed did not finish within ${Math.round(TIMEOUT_MS / 1000)}s (last: ${JSON.stringify(status)})`);
    }
    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error(`\nSEED FAILED: ${err.message}`);
  process.exit(1);
});
