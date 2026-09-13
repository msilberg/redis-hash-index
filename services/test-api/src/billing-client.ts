// The S2S client for mock-billing — test-api's origin. It turns a remote system's failure modes into
// exactly two outcomes the cache understands: a `Subscription` (or `null`) to cache, or an
// `OriginError` that must never be cached.
//
// A 404 is the one non-2xx that is an answer, not a failure: "no such subscription" returns `null`.
// Every other status, a timeout, a connection refusal and an envelope we cannot map is an OriginError.

import { serializeSubscription, type Subscription } from "@redis-hash-index/fixture";

import type { SubscriptionOrigin, SubscriptionParams } from "./subscription-service";

/** A failure of the origin itself, as opposed to the cache in front of it. The route answers 502. */
export class OriginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OriginError";
  }
}

export interface BillingClientConfig {
  /** MOCK_BILLING_URL, e.g. `http://mock-billing:3003`. */
  baseUrl: string;
  /** BILLING_TIMEOUT_MS — the whole exchange, headers and body. */
  timeoutMs: number;
}

export class BillingClient implements SubscriptionOrigin {
  constructor(private readonly config: BillingClientConfig) {}

  async getActiveSubscription(userId: string, params: SubscriptionParams = {}): Promise<Subscription | null> {
    const url = new URL(`/subscription/${encodeURIComponent(userId)}`, this.config.baseUrl);
    if (params.v !== undefined) url.searchParams.set("v", String(params.v));

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);
    let body: unknown;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new OriginError(`billing GET ${url.pathname} -> ${res.status} ${text.slice(0, 200)}`.trimEnd());
      }
      body = await res.json();
    } catch (err) {
      if (err instanceof OriginError) throw err;
      const reason = controller.signal.aborted
        ? `timed out after ${this.config.timeoutMs} ms`
        : err instanceof Error
          ? describeFetchError(err)
          : String(err);
      throw new OriginError(`billing GET ${url.pathname} failed: ${reason}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
    return toSubscription(body, userId);
  }
}

/** undici reports a refused connection as `TypeError: fetch failed` with the real error in `cause`. */
function describeFetchError(err: Error): string {
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return `${err.message}${cause}`;
}

/**
 * The provider's snake_case envelope → the internal record. The result is normalised through the
 * shared `serializeSubscription`, so the decorator's `JSON.stringify` of it is byte-identical to the
 * value the bulk seeder wrote for the same record.
 */
export function toSubscription(body: unknown, userId: string): Subscription {
  const sub = (body as { subscription?: Record<string, unknown> } | null)?.subscription;
  if (
    sub === undefined ||
    sub === null ||
    sub.customer_id !== `cus_${userId}` ||
    typeof sub.plan_id !== "string" ||
    typeof sub.status !== "string" ||
    typeof sub.seats !== "number" ||
    !isUnixSeconds(sub.current_term_end)
  ) {
    throw new OriginError(`billing returned an unexpected envelope for ${userId}`);
  }
  const subscription: Subscription = {
    userId,
    planId: sub.plan_id,
    status: sub.status,
    renewsAt: new Date(sub.current_term_end * 1000).toISOString().slice(0, 10),
    seats: sub.seats,
  };
  return JSON.parse(serializeSubscription(subscription)) as Subscription;
}

/** A whole number of seconds that `Date` can represent (up to year 9999). */
function isUnixSeconds(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 253_402_300_799;
}
