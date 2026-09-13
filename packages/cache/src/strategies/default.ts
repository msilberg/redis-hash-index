// The base cache strategy: one Redis client, a plain GET and a plain SET EX.
//
// It knows nothing about indexes, categories or entity IDs. Subclasses add those; this class owns
// the connection so every subclass reuses it rather than opening or being handed a second one.

import { assertValidTtl } from "../keys";
import type { RedisClient } from "../redis";

// Reserved for base-level tuning; the base strategy currently has nothing to configure.
export type DefaultCacheStrategyOptions = Record<string, never>;

export class DefaultCacheStrategy {
  /** Shared with every subclass — the point of the base class. */
  protected readonly redis: RedisClient;

  constructor(redis: RedisClient, _options?: DefaultCacheStrategyOptions) {
    this.redis = redis;
  }

  /** A plain `GET`. `null` is a miss. */
  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /** `SET key value EX ttl`. The TTL is validated before any command, so a rejected call writes nothing. */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    assertValidTtl(ttlSeconds);
    await this.redis.set(key, value, "EX", ttlSeconds);
  }
}
