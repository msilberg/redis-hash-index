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
} from "./config";
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
 * Yield every user's fixture in id order. `indexKeyFor` is injected (it comes from packages/cache's
 * `EntityIndex.indexKeyFor`) so the index key format has exactly one implementation in the repo.
 */
export function* generateUsers(
  seedKeys: number,
  seedValue: number,
  indexKeyFor: (userId: string) => string,
): Generator<UserFixture> {
  const users = userCount(seedKeys);
  let recordOrdinal = 0;
  for (let i = 0; i < users; i += 1) {
    const userId = userIdFor(i);
    const variants = variantsFor(i, seedValue);
    const records: UserFixture["records"] = [];
    for (let v = 1; v <= variants; v += 1) {
      const params = `{"v":${v}}`;
      const cacheKey = [SERVICE, TENANT, CATEGORY, userId, params].join("::");
      const planId = PLAN_IDS[recordOrdinal % PLAN_IDS.length] as string;
      const seats = 1 + (hashInt(i * 8 + v, seedValue) % 10);
      const renewDay = 1 + (hashInt(i * 8 + v + 101, seedValue) % 28);
      const value = JSON.stringify({
        userId,
        planId,
        status: "active",
        renewsAt: `2026-11-${String(renewDay).padStart(2, "0")}`,
        seats,
      });
      records.push({ cacheKey, value });
      recordOrdinal += 1;
    }
    yield { userId, indexKey: indexKeyFor(userId), records };
  }
}
