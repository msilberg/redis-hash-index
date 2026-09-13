// A fake billing provider: the slow, authoritative origin that the read-through cache sits in front
// of. Deterministic from SEED_VALUE, so the same user always gets the same answer and the demo can
// be checked with curl.

export interface Subscription {
  userId: string;
  planId: string;
  status: "active";
  renewsAt: string;
  seats: number;
  addons?: string[];
}

export interface SubscriptionParams {
  includeAddons: boolean;
}

export interface BillingOriginOptions {
  /** Delay before every answer, in milliseconds. */
  latencyMs: number;
  /** A user for whom the origin always throws. */
  failUser?: string;
  seedValue: number;
}

export class OriginError extends Error {
  override readonly name = "OriginError";
}

const PLAN_IDS = ["pro-monthly", "pro-yearly", "team-monthly", "gen-ai-100k"] as const;
const ADDONS = ["priority-support", "sso", "audit-log", "extra-storage"] as const;

/** One user in this many has no subscription — an authoritative negative, not an error. */
const NO_SUBSCRIPTION_ONE_IN = 8;

export class BillingOrigin {
  constructor(private readonly options: BillingOriginOptions) {}

  async getActiveSubscription(userId: string, params: SubscriptionParams): Promise<Subscription | null> {
    await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    if (userId === this.options.failUser) {
      throw new OriginError(`billing provider unavailable for ${userId}`);
    }

    const n = Number(userId.slice(2));
    const h = hashInt(n, this.options.seedValue);
    if (h % NO_SUBSCRIPTION_ONE_IN === NO_SUBSCRIPTION_ONE_IN - 1) return null;

    const subscription: Subscription = {
      userId,
      planId: PLAN_IDS[h % PLAN_IDS.length] as string,
      status: "active",
      renewsAt: `2026-11-${String(1 + (hashInt(n + 101, this.options.seedValue) % 28)).padStart(2, "0")}`,
      seats: 1 + (hashInt(n + 211, this.options.seedValue) % 10),
    };
    if (params.includeAddons) {
      subscription.addons = ADDONS.filter((_, i) => (hashInt(n * 8 + i, this.options.seedValue) & 1) === 1);
    }
    return subscription;
  }
}

/**
 * Integer avalanche hash salted by the seed — the same function as services/benchmark/src/prng.ts
 * (US-005). Services share only packages/cache, so it is repeated here rather than imported.
 */
function hashInt(n: number, salt: number): number {
  let h = (Math.trunc(n) ^ Math.trunc(salt)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}
