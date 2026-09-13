// The cached read of a user's subscription. The caching is the decorator — this method never names a
// key or touches Redis. `configureCache` must have run first (src/index.ts does it at bootstrap).

import { Cache, CacheKey, CacheStrategy, TTL } from "@redis-hash-index/cache";

import type { BillingProvider, Subscription, SubscriptionParams } from "./billing-provider";

export class SubscriptionService {
  constructor(private readonly billing: BillingProvider) {}

  @Cache(CacheKey.ACTIVE_SUBSCRIPTION, TTL.MEDIUM, CacheStrategy.ENTITY_INDEX_CACHE)
  async getActiveSubscription(userId: string, params: SubscriptionParams = {}): Promise<Subscription | null> {
    return await this.billing.getActiveSubscription(userId, params);
  }
}
