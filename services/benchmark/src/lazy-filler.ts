// The lazy paths' filler: the benchmark does not cache anything itself. It asks test-api for each
// record over HTTP, and test-api's `@Cache` fills Redis from mock-billing on the miss:
//
//   benchmark --GET /subscription/:userId?v=n--> test-api --GET--> mock-billing
//
// It also reads mock-billing's `/health` so the seeder can refuse a seed whose SEED_VALUE the origin
// does not share. See tasks/US-011.md.

import type { LazyFiller } from "./seeder";

/** test-api answered 502: the origin failed for this record and nothing was cached. The seed skips it. */
export class OriginFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginFailedError";
  }
}

export interface TestApiFillerConfig {
  testApiBaseUrl: string;
  mockBillingBaseUrl: string;
  /** Per request. test-api's own origin timeout (BILLING_TIMEOUT_MS) should be well below it. */
  timeoutMs: number;
}

export class TestApiFiller implements LazyFiller {
  constructor(private readonly config: TestApiFillerConfig) {}

  async originSeedValue(): Promise<number> {
    const url = new URL("/health", this.config.mockBillingBaseUrl);
    const res = await fetch(url, { signal: AbortSignal.timeout(this.config.timeoutMs) });
    if (!res.ok) throw new Error(`GET ${url.href} -> ${res.status}`);
    const { seedValue } = (await res.json()) as { seedValue?: unknown };
    if (typeof seedValue !== "number" || !Number.isInteger(seedValue)) {
      throw new Error(`GET ${url.href} returned no integer seedValue`);
    }
    return seedValue;
  }

  async fill(userId: string, variant: number): Promise<void> {
    const url = new URL(`/subscription/${encodeURIComponent(userId)}`, this.config.testApiBaseUrl);
    url.searchParams.set("v", String(variant));
    const res = await fetch(url, { signal: AbortSignal.timeout(this.config.timeoutMs) });
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; subscription?: unknown };
    if (res.status === 502) {
      throw new OriginFailedError(typeof body.error === "string" ? body.error : `GET ${url.pathname} -> 502`);
    }
    if (!res.ok) {
      throw new Error(`GET ${url.href} -> ${res.status}${typeof body.error === "string" ? `: ${body.error}` : ""}`);
    }
    // Every record the seeder asks for exists in the generator; a null means the origin disagrees.
    if (body.subscription === null || body.subscription === undefined) {
      throw new Error(`test-api found no subscription for ${userId} v${variant} — the origin disagrees with the fixture`);
    }
  }
}
