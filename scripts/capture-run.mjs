#!/usr/bin/env node
// Capture the WebSocket frames of one run to a JSON file, for the committed sample output under
// docs/ (docs/run-index.json, docs/run-legacy.json). Browser screenshots would be nicer; this
// environment has no browser tooling, so the README references these instead.
//
//   node scripts/capture-run.mjs <v1|v2> <seconds> <outfile>
//
// Assumes the stack is already up and seeded (make up && make seed).

import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const [mode, secondsRaw, outfile] = process.argv.slice(2);
if ((mode !== "v1" && mode !== "v2") || !secondsRaw || !outfile) {
  console.error("usage: node scripts/capture-run.mjs <v1|v2> <seconds> <outfile>");
  process.exit(2);
}
const seconds = Number(secondsRaw);
const BASE = "http://localhost:3000";

const frames = [];
const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`);
ws.addEventListener("message", (ev) => {
  try {
    frames.push(JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()));
  } catch {
    /* ignore non-JSON */
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", () => reject(new Error("could not connect to /ws")));
});

const started = await (
  await fetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  })
).json();
console.error(`run started: ${JSON.stringify(started)} — capturing ${seconds}s`);

await sleep(seconds * 1000);

await fetch(`${BASE}/api/run/stop`, { method: "POST" });
await sleep(500);
ws.close();

const samples = frames.filter((f) => f.t === "sample");
const summary = {
  mode,
  capturedSeconds: seconds,
  capturedAt: new Date().toISOString(),
  note:
    "WebSocket frames from one demo run. Sample output committed in lieu of a browser screenshot " +
    "(no browser tooling in the build environment). x = elapsedSec, y = latencyMs (log scale in the UI).",
  frameCounts: frames.reduce((acc, f) => ({ ...acc, [f.t]: (acc[f.t] ?? 0) + 1 }), {}),
  latencyMsRange: samples.length
    ? [Math.min(...samples.map((s) => s.latencyMs)), Math.max(...samples.map((s) => s.latencyMs))]
    : null,
  frames,
};
writeFileSync(outfile, JSON.stringify(summary, null, 2) + "\n");
console.error(`wrote ${frames.length} frames (${samples.length} samples) to ${outfile}`);
