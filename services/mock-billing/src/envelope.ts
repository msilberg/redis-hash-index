// The wire format: shaped like a real billing provider's API (snake_case, unix seconds, object tags),
// deliberately NOT like our internal `Subscription`. test-api owns the mapping back.

import type { Subscription } from "@redis-hash-index/fixture";

export interface SubscriptionEnvelope {
  subscription: {
    id: string;
    customer_id: string;
    plan_id: string;
    status: string;
    /** Unix seconds — midnight UTC of the fixture's `renewsAt` date. */
    current_term_end: number;
    seats: number;
    object: "subscription";
  };
  customer: { id: string; object: "customer" };
}

/** Every field derives from the generator's record, the user id and the variant — nothing else. */
export function toEnvelope(subscription: Subscription, variant: number): SubscriptionEnvelope {
  const customerId = `cus_${subscription.userId}`;
  return {
    subscription: {
      id: `sub_${subscription.userId}_${variant}`,
      customer_id: customerId,
      plan_id: subscription.planId,
      status: subscription.status,
      current_term_end: Date.parse(`${subscription.renewsAt}T00:00:00Z`) / 1000,
      seats: subscription.seats,
      object: "subscription",
    },
    customer: { id: customerId, object: "customer" },
  };
}
