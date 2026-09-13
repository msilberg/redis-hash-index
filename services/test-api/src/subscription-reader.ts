// The production shape this demo is modelled on: a method that asks the billing provider, with
// caching bolted on by a decorator. Nothing at the call site mentions Redis — which is exactly why,
// on the day someone needs to invalidate one user, nobody knows what the keys look like.

import { Cached, type ReadThroughCache } from "@redis-hash-index/cache";
import { CATEGORY } from "./config";
import type { BillingOrigin, Subscription, SubscriptionParams } from "./origin";

/** Cached subscriptions live an hour, like the fixture. A "no subscription" answer, one minute. */
export const SUBSCRIPTION_TTL_SECONDS = 3600;
export const NO_SUBSCRIPTION_TTL_SECONDS = 60;

export class SubscriptionReader {
  constructor(
    readonly cache: ReadThroughCache,
    private readonly origin: BillingOrigin,
  ) {}

  @Cached({
    category: CATEGORY,
    ttlSeconds: SUBSCRIPTION_TTL_SECONDS,
    cacheNegative: true,
    negativeTtlSeconds: NO_SUBSCRIPTION_TTL_SECONDS,
  })
  async getActiveSubscription(userId: string, params: SubscriptionParams): Promise<Subscription | null> {
    return await this.origin.getActiveSubscription(userId, params);
  }
}
