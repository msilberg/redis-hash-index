import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { generateUsers, type Subscription } from "@redis-hash-index/fixture";

import { createApp } from "./app";
import { BillingProvider } from "./provider";

// Pure HTTP against the app on an ephemeral port — no database anywhere in this service.

const FAIL_USER = "u_0000002";
const idxKey = (userId: string): string => `entityIndex::demo::activeSubscription::${userId}`;

let server: Server;
let baseUrl: string;

before(async () => {
  const app = createApp(new BillingProvider({ seedValue: 1, latencyMs: 0, failUser: FAIL_USER }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET /health reports ok and the SEED_VALUE it generates from", async () => {
  assert.deepEqual(await get("/health"), { status: 200, body: { ok: true, seedValue: 1 } });
});

test("GET /subscription/:userId?v=n is a snake_case envelope derived from the generator", async () => {
  const user = [...generateUsers(20, 1, idxKey)].find((u) => u.records.length >= 2);
  assert.ok(user);
  const record = JSON.parse(user.records[1]?.value ?? "null") as Subscription;

  const { status, body } = await get(`/subscription/${user.userId}?v=2&include_addons=true`);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    subscription: {
      id: `sub_${user.userId}_2`,
      customer_id: `cus_${user.userId}`,
      plan_id: record.planId,
      status: record.status,
      current_term_end: Date.parse(`${record.renewsAt}T00:00:00Z`) / 1000,
      seats: record.seats,
      object: "subscription",
    },
    customer: { id: `cus_${user.userId}`, object: "customer" },
  });

  // Deterministic: the same request is the same envelope, and include_addons changes nothing.
  assert.deepEqual((await get(`/subscription/${user.userId}?v=2`)).body, body);
  // v defaults to 1.
  assert.deepEqual((await get(`/subscription/${user.userId}`)).body, (await get(`/subscription/${user.userId}?v=1`)).body);
});

test("404 for a variant the user does not have, 503 for ORIGIN_FAIL_USER, 400 for a bad id or v", async () => {
  const user = [...generateUsers(20, 1, idxKey)][0];
  assert.ok(user);
  const missing = await get(`/subscription/${user.userId}?v=${user.records.length + 1}`);
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.body.error, "string");

  const failing = await get(`/subscription/${FAIL_USER}`);
  assert.equal(failing.status, 503);
  assert.match(String(failing.body.error), /ORIGIN_FAIL_USER/);

  for (const path of ["/subscription/bogus", "/subscription/u_000001", "/subscription/u_0000001?v=0", "/subscription/u_0000001?v=x"]) {
    assert.equal((await get(path)).status, 400, path);
  }
});
