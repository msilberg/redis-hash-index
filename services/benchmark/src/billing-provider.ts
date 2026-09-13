// The mock billing provider — the origin behind the @Cache decorator.
//
// Deterministic: for a given userId and variant it returns exactly the record the bulk fixture
// generator writes, so a user filled lazily and a user seeded in bulk are byte-identical in Redis.
// It never touches Redis. See tasks/US-010.md.

import { setTimeout as sleep } from "node:timers/promises";

import { recordsFor, variantsFor } from "./fixture";

export interface Subscription {
  userId: string;
  planId: string;
  status: string;
  renewsAt: string;
  seats: number;
}

/** Call parameters; they become the `params` segment of the cache key. `v` selects the variant. */
export interface SubscriptionParams {
  v?: number;
}

export interface BillingProviderConfig {
  seedValue: number;
  /** ORIGIN_LATENCY_MS — an awaited delay before every answer. */
  latencyMs: number;
  /** ORIGIN_FAIL_USER — this user always fails, so "an origin error is never cached" is demonstrable. */
  failUser?: string | undefined;
}

/** A failure of the origin itself, as opposed to the cache in front of it. */
export class OriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginError";
  }
}

const USER_ID_RE = /^u_(\d{7})$/;

export class BillingProvider {
  /** `ordinals[i]` = records owned by users `0 .. i-1`, grown on demand. */
  private readonly ordinals: number[] = [0];

  constructor(private readonly config: BillingProviderConfig) {}

  /** The user's subscription for variant `params.v` (default 1), or `null` if the user has no such variant. */
  async getActiveSubscription(userId: string, params: SubscriptionParams = {}): Promise<Subscription | null> {
    if (this.config.latencyMs > 0) await sleep(this.config.latencyMs);
    if (userId === this.config.failUser) {
      throw new OriginError(`billing provider unavailable for ${userId} (ORIGIN_FAIL_USER)`);
    }
    const match = USER_ID_RE.exec(userId);
    if (match === null) throw new OriginError(`billing provider rejected user id ${JSON.stringify(userId)}`);
    const i = Number(match[1]);
    const variant = params.v ?? 1;
    const record = recordsFor(i, this.config.seedValue, this.ordinalFor(i))[variant - 1];
    return record === undefined ? null : (JSON.parse(record.value) as Subscription);
  }

  private ordinalFor(i: number): number {
    for (let j = this.ordinals.length - 1; j < i; j += 1) {
      this.ordinals.push((this.ordinals[j] as number) + variantsFor(j, this.config.seedValue));
    }
    return this.ordinals[i] as number;
  }
}
