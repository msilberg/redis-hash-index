import assert from "node:assert/strict";
import { test } from "node:test";

import { expectedTotals, generateUsers, serializeSubscription, userCount, userIdFor, variantsFor } from "./fixture";
import { mulberry32 } from "./prng";
import type { Subscription } from "./schema";

const idxKey = (userId: string): string => `entityIndex::demo::activeSubscription::${userId}`;

test("mulberry32 is deterministic for a given seed and diverges for another", () => {
  const a = mulberry32(1);
  const b = mulberry32(1);
  const c = mulberry32(2);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [c(), c(), c(), c()]);
  for (const n of seqA) assert.ok(n >= 0 && n < 1);
});

test("userCount derives ~SEED_KEYS/2 users, at least one", () => {
  assert.equal(userCount(50_000), 25_000);
  assert.equal(userCount(2_000_000), 1_000_000);
  assert.equal(userCount(1), 1);
});

test("variantsFor is 1..3 and order-independent", () => {
  for (let i = 0; i < 500; i += 1) {
    const v = variantsFor(i, 1);
    assert.ok(v >= 1 && v <= 3, `variant ${v} out of range at ${i}`);
  }
});

test("userIdFor zero-pads to seven digits", () => {
  assert.equal(userIdFor(0), "u_0000000");
  assert.equal(userIdFor(42), "u_0000042");
  assert.equal(userIdFor(1_234_567), "u_1234567");
});

test("generateUsers is byte-identical across runs with the same seed", () => {
  const first = [...generateUsers(2_000, 1, idxKey)];
  const second = [...generateUsers(2_000, 1, idxKey)];
  assert.deepEqual(first, second);

  const other = [...generateUsers(2_000, 7, idxKey)];
  assert.notDeepEqual(first, other);
});

test("generateUsers emits well-formed cache keys, values and index membership", () => {
  const users = [...generateUsers(200, 1, idxKey)];
  const totals = expectedTotals(200, 1);
  assert.equal(users.length, totals.users);

  let records = 0;
  for (const user of users) {
    assert.match(user.userId, /^u_\d{7}$/);
    assert.equal(user.indexKey, idxKey(user.userId));
    assert.ok(user.records.length >= 1 && user.records.length <= 3);
    user.records.forEach((record, i) => {
      assert.equal(
        record.cacheKey,
        `test-api::demo::activeSubscription::${user.userId}::{"v":${i + 1}}`,
      );
      const parsed = JSON.parse(record.value) as {
        userId: string;
        planId: string;
        status: string;
        renewsAt: string;
        seats: number;
      };
      assert.equal(parsed.userId, user.userId);
      assert.equal(parsed.status, "active");
      assert.match(parsed.renewsAt, /^2026-11-\d{2}$/);
      assert.ok(parsed.seats >= 1 && parsed.seats <= 10);
      assert.ok(
        ["pro-monthly", "pro-yearly", "team-monthly", "gen-ai-100k"].includes(parsed.planId),
      );
    });
    records += user.records.length;
  }
  assert.equal(records, totals.cacheKeys);
});

test("serializeSubscription fixes the key order and drops foreign fields", () => {
  const [user] = [...generateUsers(2, 1, idxKey)];
  assert.ok(user?.records[0]);
  const parsed = JSON.parse(user.records[0].value) as Subscription;
  const shuffled = { seats: parsed.seats, renewsAt: parsed.renewsAt, status: parsed.status, planId: parsed.planId, userId: parsed.userId };
  assert.equal(serializeSubscription(shuffled), user.records[0].value);
  assert.equal(serializeSubscription({ ...parsed, extra: true } as Subscription), user.records[0].value);
  // What test-api does: parse the canonical string, so the decorator's JSON.stringify reproduces it.
  assert.equal(JSON.stringify(JSON.parse(serializeSubscription(shuffled))), user.records[0].value);
});
