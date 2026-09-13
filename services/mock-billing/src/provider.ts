// The fake third party's data: for a given userId and variant it returns exactly the record the bulk
// fixture generator writes. Nothing here is invented per request, so the same userId, SEED_VALUE and
// variant produce the same answer on every call and in every container. It holds no cache and no
// connection to one. See tasks/US-011.md.

import { setTimeout as sleep } from "node:timers/promises";

import { recordsFor, variantsFor, type Subscription } from "@redis-hash-index/fixture";

export interface BillingProviderConfig {
  seedValue: number;
  /** ORIGIN_LATENCY_MS — an awaited delay before every answer. */
  latencyMs: number;
  /** ORIGIN_FAIL_USER — this user always fails, so "an origin error is never cached" is demonstrable. */
  failUser?: string | undefined;
}

/** The provider is down for this request — the route answers 503. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

const USER_ID_RE = /^u_(\d{7})$/;

export class BillingProvider {
  /** `ordinals[i]` = records owned by users `0 .. i-1`, grown on demand. */
  private readonly ordinals: number[] = [0];

  constructor(private readonly config: BillingProviderConfig) {}

  get seedValue(): number {
    return this.config.seedValue;
  }

  /** The user's subscription for `variant`, or `null` if the user has no such variant. */
  async getActiveSubscription(userId: string, variant = 1): Promise<Subscription | null> {
    if (this.config.latencyMs > 0) await sleep(this.config.latencyMs);
    if (userId === this.config.failUser) {
      throw new ProviderUnavailableError(`billing provider unavailable for ${userId} (ORIGIN_FAIL_USER)`);
    }
    const match = USER_ID_RE.exec(userId);
    if (match === null) throw new RangeError(`not a user id: ${JSON.stringify(userId)}`);
    const i = Number(match[1]);
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
