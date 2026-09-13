import assert from "node:assert/strict";
import { test } from "node:test";

import { generateUsers } from "@redis-hash-index/fixture";

import { BillingProvider, ProviderUnavailableError } from "./provider";

// Pure: the provider holds no cache, so this file needs no database.

const idxKey = (userId: string): string => `entityIndex::demo::activeSubscription::${userId}`;

test("returns exactly the fixture generator's record for every user and variant", async () => {
  for (const seedValue of [1, 7]) {
    const provider = new BillingProvider({ seedValue, latencyMs: 0 });
    // Out of order, so the on-demand ordinal table is exercised from both directions.
    const users = [...generateUsers(3_000, seedValue, idxKey)].reverse();
    for (const user of users) {
      for (const [n, record] of user.records.entries()) {
        const subscription = await provider.getActiveSubscription(user.userId, n + 1);
        assert.equal(JSON.stringify(subscription), record.value, `${user.userId} v${n + 1} seed ${seedValue}`);
      }
    }
  }
});

test("variant defaults to 1; a variant the user does not have is null", async () => {
  const provider = new BillingProvider({ seedValue: 1, latencyMs: 0 });
  const [user] = [...generateUsers(2, 1, idxKey)];
  assert.ok(user);
  assert.equal(JSON.stringify(await provider.getActiveSubscription(user.userId)), user.records[0]?.value);
  assert.equal(await provider.getActiveSubscription(user.userId, user.records.length + 1), null);
});

test("ORIGIN_FAIL_USER always throws ProviderUnavailableError; other users still answer", async () => {
  const provider = new BillingProvider({ seedValue: 1, latencyMs: 0, failUser: "u_0000002" });
  await assert.rejects(provider.getActiveSubscription("u_0000002"), ProviderUnavailableError);
  await assert.rejects(provider.getActiveSubscription("u_0000002"), /ORIGIN_FAIL_USER/);
  assert.ok(await provider.getActiveSubscription("u_0000003"));
  await assert.rejects(provider.getActiveSubscription("not-a-user"), RangeError);
});

test("ORIGIN_LATENCY_MS delays the answer", async () => {
  const provider = new BillingProvider({ seedValue: 1, latencyMs: 60 });
  const started = performance.now();
  await provider.getActiveSubscription("u_0000001");
  assert.ok(performance.now() - started >= 55, "answered before ORIGIN_LATENCY_MS elapsed");
});
