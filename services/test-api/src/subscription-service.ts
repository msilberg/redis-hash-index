// The cached read of a user's subscription. The caching is the decorator — this method never names a
// key or touches Redis. `configureCache` must have run first (test-api's bootstrap does it).

import { Cache, CacheKey, CacheStrategy, TTL } from "@redis-hash-index/cache";
import type { Subscription } from "@redis-hash-index/fixture";

/**
 * Call parameters; they become the `params` segment of the cache key, so this type IS the key
 * contract. `v` selects the variant. Add nothing here that the bulk seeder does not also write.
 */
export interface SubscriptionParams {
  v?: number;
}

/** What the service reads from on a miss — the S2S `BillingClient`, or a stub in tests. */
export interface SubscriptionOrigin {
  getActiveSubscription(userId: string, params?: SubscriptionParams): Promise<Subscription | null>;
}

export class SubscriptionService {
  constructor(private readonly billing: SubscriptionOrigin) {}

  @Cache(CacheKey.ACTIVE_SUBSCRIPTION, TTL.MEDIUM, CacheStrategy.ENTITY_INDEX_CACHE)
  getActiveSubscription(userId: string, params: SubscriptionParams = {}): Promise<Subscription | null> {
    return this.billing.getActiveSubscription(userId, params);
  }
}
