// The innocent bystander. It reads entitlements through the shared entity index and reports how
// long Redis took, so that when the webhook blocks the server on an O(N) keyspace enumeration we
// can watch it happen to a request that did nothing wrong.
//
// It reads via SMEMBERS then MGET only. It never enumerates the keyspace — not even on an admin
// route. See docs/REDIS-SCHEMA.md.

import { EntityIndex, type RedisClient } from "@redis-hash-index/cache";
import type { Request, Response } from "express";
import { CATEGORY, TENANT } from "./config";

const USER_ID_RE = /^u_\d{7}$/;

/** The slice of a Redis client this service touches. It only ever reads. */
export interface RedisReader {
  smembers(key: string): Promise<string[]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
}

export class TestApiController {
  private readonly index: EntityIndex;

  constructor(private readonly redis: RedisReader) {
    this.index = new EntityIndex(redis as unknown as RedisClient, { categories: [CATEGORY] });
  }

  health = (_req: Request, res: Response): void => {
    res.json({ ok: true });
  };

  getUserSubscription = (req: Request, res: Response): void => {
    const userId = req.params.userId;
    if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
      res.status(400).json({ error: "userId must match ^u_\\d{7}$" });
      return;
    }

    const indexKey = this.index.indexKeyFor(TENANT, CATEGORY, userId);
    void this.readUserSubscription(indexKey)
      .then((body) => {
        res.json({ userId, ...body });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `redis read failed: ${message}` });
      });
  };

  /**
   * One entitlement read: SMEMBERS the entity's index set, then MGET the members. `latencyMs`
   * measures only the Redis round trip, per docs/API.md.
   *
   * `hit: false` with `variants: 0` after a user has been invalidated is the correct answer — it is
   * never treated as an error and there is no scan fallback.
   */
  private async readUserSubscription(
    indexKey: string,
  ): Promise<{ hit: boolean; variants: number; latencyMs: number }> {
    const started = process.hrtime.bigint();
    const members = await this.redis.smembers(indexKey);
    const values = members.length > 0 ? await this.redis.mget(...members) : [];
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    return {
      hit: values.some((value) => Boolean(value)),
      variants: values.filter((value) => Boolean(value)).length,
      latencyMs,
    };
  }
}
