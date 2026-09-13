// The cached read of a user's subscription. The caching is the decorator — this method never names a
// key or touches Redis. `configureCache` must have run first (each service's bootstrap does it).

import { Cache, CacheKey, CacheStrategy, TTL } from "@redis-hash-index/cache";

import type { Subscription, SubscriptionParams } from "./billing-provider";

/** What the service reads from on a miss — the mock `BillingProvider`, or a wrapper around it. */
export interface SubscriptionOrigin {
  getActiveSubscription(userId: string, params?: SubscriptionParams): Promise<Subscription | null>;
}

export class SubscriptionService {
  constructor(private readonly billing: SubscriptionOrigin) {}

  @Cache(CacheKey.ACTIVE_SUBSCRIPTION, TTL.MEDIUM, CacheStrategy.ENTITY_INDEX_CACHE)
  async getActiveSubscription(userId: string, params: SubscriptionParams = {}): Promise<Subscription | null> {
    return await this.billing.getActiveSubscription(userId, params);
  }
}
