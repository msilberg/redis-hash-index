// The deterministic fixture. Given SEED_KEYS and SEED_VALUE this yields byte-identical users,
// cache keys and values every run — see US-005.md and docs/REDIS-SCHEMA.md.
//
// A cache key is `test-api::demo::activeSubscription::<userId>::{"v":N}` (five `::` segments, the
// last opaque). Each user has 1–3 variants chosen from the hash, and one index set listing them.

import {
  AVERAGE_VARIANTS,
  CATEGORY,
  PLAN_IDS,
  SERVICE,
  TENANT,
  type Subscription,
} from "./schema";
import { hashInt } from "./prng";

export interface UserFixture {
  userId: string;
  /** The index set key for this user, built through packages/cache so it can never drift. */
  indexKey: string;
  /** The user's 1–3 cache records, in variant order. */
  records: Array<{ cacheKey: string; value: string }>;
}

export interface ExpectedTotals {
  users: number;
  cacheKeys: number;
  indexKeys: number;
}

/**
 * The one serialisation of a {@link Subscription}, in a fixed key order. The bulk writer stores this
 * string, and test-api's envelope mapper normalises through it, so a lazily filled value is
 * byte-identical to a bulk-seeded one. Two `JSON.stringify` calls over objects built in different
 * files would silently disagree on key order.
 */
export function serializeSubscription(subscription: Subscription): string {
  const { userId, planId, status, renewsAt, seats } = subscription;
  return JSON.stringify({ userId, planId, status, renewsAt, seats });
}

/** User count derived so `users * averageVariants ≈ SEED_KEYS`. Always at least one user. */
export function userCount(seedKeys: number): number {
  return Math.max(1, Math.round(seedKeys / AVERAGE_VARIANTS));
}

export function userIdFor(i: number): string {
  return `u_${String(i).padStart(7, "0")}`;
}

/** 1–3, deterministic from the user index and seed. Independent of iteration order. */
export function variantsFor(i: number, seedValue: number): number {
  return 1 + (hashInt(i, seedValue) % 3);
}

/**
 * The key/record totals this seed will produce, without materialising anything. Used both for the
 * pre-completion status payload and for the post-seed `DBSIZE` assertion.
 */
export function expectedTotals(seedKeys: number, seedValue: number): ExpectedTotals {
  const users = userCount(seedKeys);
  let cacheKeys = 0;
  for (let i = 0; i < users; i += 1) {
    cacheKeys += variantsFor(i, seedValue);
  }
  return { users, cacheKeys, indexKeys: users };
}

/**
 * One user's 1–3 cache records, in variant order. `recordOrdinal` is the number of records every
 * earlier user owns — plan IDs cycle over the whole fixture, so a record depends on its position.
 * The bulk writer and mock-billing both build records here, so they cannot disagree.
 */
export function recordsFor(i: number, seedValue: number, recordOrdinal: number): UserFixture["records"] {
  const userId = userIdFor(i);
  const variants = variantsFor(i, seedValue);
  const records: UserFixture["records"] = [];
  for (let v = 1; v <= variants; v += 1) {
    const params = `{"v":${v}}`;
    const cacheKey = [SERVICE, TENANT, CATEGORY, userId, params].join("::");
    const planId = PLAN_IDS[(recordOrdinal + v - 1) % PLAN_IDS.length] as string;
    const seats = 1 + (hashInt(i * 8 + v, seedValue) % 10);
    const renewDay = 1 + (hashInt(i * 8 + v + 101, seedValue) % 28);
    const value = serializeSubscription({
      userId,
      planId,
      status: "active",
      renewsAt: `2026-11-${String(renewDay).padStart(2, "0")}`,
      seats,
    });
    records.push({ cacheKey, value });
  }
  return records;
}

/** Records owned by users `0 .. i-1` — the `recordOrdinal` of user `i`. O(i). */
export function recordOrdinalFor(i: number, seedValue: number): number {
  let ordinal = 0;
  for (let j = 0; j < i; j += 1) ordinal += variantsFor(j, seedValue);
  return ordinal;
}

/**
 * Yield users `fromUser .. userCount-1` in id order. `indexKeyFor` is injected (it comes from
 * packages/cache's `EntityIndexCacheStrategy.indexKeyFor`) so the index key format has exactly one
 * implementation in the repo.
 */
export function* generateUsers(
  seedKeys: number,
  seedValue: number,
  indexKeyFor: (userId: string) => string,
  fromUser = 0,
): Generator<UserFixture> {
  const users = userCount(seedKeys);
  let recordOrdinal = recordOrdinalFor(fromUser, seedValue);
  for (let i = fromUser; i < users; i += 1) {
    const userId = userIdFor(i);
    const records = recordsFor(i, seedValue, recordOrdinal);
    recordOrdinal += records.length;
    yield { userId, indexKey: indexKeyFor(userId), records };
  }
}
