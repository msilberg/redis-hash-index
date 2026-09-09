// US-007 — the live UI. These checks are pure (no Redis): the page must be self-contained and
// `createApp` must serve it at `GET /`.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { createApp } from "./app";
import type { Runner } from "./runner";
import type { Seeder } from "./seeder";
import { UI_HTML } from "./ui";

const servers: Server[] = [];

async function serve(): Promise<string> {
  // GET / touches neither the seeder nor the runner, so bare stubs are enough here.
  const app = createApp({ seeder: {} as unknown as Seeder, runner: {} as unknown as Runner });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the page is self-contained: no build step, no CDN dependency", () => {
  assert.match(UI_HTML, /^<!doctype html>/i);
  // no external scripts or stylesheets — the chart must render offline from a fresh clone
  assert.doesNotMatch(UI_HTML, /<script[^>]+src=/i);
  assert.doesNotMatch(UI_HTML, /<link[^>]+href="https?:/i);
  assert.doesNotMatch(UI_HTML, /https?:\/\/[^"' )]+\.(?:js|css)/i);
});

test("the chart is a canvas with a logarithmic y axis and a dispatch marker", () => {
  assert.match(UI_HTML, /getContext\("2d"\)/);
  assert.match(UI_HTML, /Math\.log\(/); // log-scale projection
  assert.match(UI_HTML, /Math\.LN10/);
  assert.match(UI_HTML, /eviction batch dispatched/);
  assert.match(UI_HTML, /logarithmic/i);
});

test("the three controls and the seed fallback are present", () => {
  assert.match(UI_HTML, /Measure legacy \(KEYS\) eviction/);
  assert.match(UI_HTML, /Measure hashed index eviction/);
  assert.match(UI_HTML, /id="btn-stop"/);
  assert.match(UI_HTML, /id="btn-seed"/);
});

test("the WebSocket is auto-reconnecting and redraws from history", () => {
  assert.match(UI_HTML, /new WebSocket/);
  assert.match(UI_HTML, /onclose/);
  assert.match(UI_HTML, /setTimeout\(connect/);
  assert.match(UI_HTML, /"history"/);
});

test("GET / serves the page as HTML", async () => {
  const base = await serve();
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const body = await res.text();
  assert.match(body, /Measure hashed index eviction/);
  assert.equal(body, UI_HTML);
});
