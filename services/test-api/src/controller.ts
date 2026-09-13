// The innocent bystander. It reads entitlements through the shared entity index and reports how
// long Redis took, so that when the webhook blocks the server on an O(N) keyspace enumeration we
// can watch it happen to a request that did nothing wrong.
//
// It reads via SMEMBERS then MGET, and fills through the shared read-through cache, which writes
// with registerMany. It never enumerates the keyspace — not even on an admin route.
// See docs/REDIS-SCHEMA.md.

import {
  EntityIndex,
  ReadThroughCache,
  captureReads,
  type ReadThroughRedis,
  type RedisClient,
} from "@redis-hash-index/cache";
import type { Request, Response } from "express";
import { CATEGORY, SERVICE, TENANT } from "./config";
import type { BillingOrigin } from "./origin";
import { SubscriptionReader } from "./subscription-reader";

const USER_ID_RE = /^u_\d{7}$/;

/** The slice of a Redis client this service touches: index reads, plus the read-through fill. */
export interface TestApiRedis extends RedisClient, ReadThroughRedis {
  mget(...keys: string[]): Promise<Array<string | null>>;
  scard(key: string): Promise<number>;
}

export class TestApiController {
  private readonly index: EntityIndex;
  private readonly subscriptions: SubscriptionReader;

  constructor(
    private readonly redis: TestApiRedis,
    origin: BillingOrigin,
  ) {
    this.index = new EntityIndex(redis, { categories: [CATEGORY] });
    const cache = new ReadThroughCache(redis, this.index, { service: SERVICE, tenant: TENANT });
    this.subscriptions = new SubscriptionReader(cache, origin);
  }

  health = (_req: Request, res: Response): void => {
    res.json({ ok: true });
  };

  getEntitlement = (req: Request, res: Response): void => {
    const userId = req.params.userId;
    if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
      res.status(400).json({ error: "userId must match ^u_\\d{7}$" });
      return;
    }

    const indexKey = this.index.indexKeyFor(TENANT, CATEGORY, userId);
    void this.readEntitlement(indexKey)
      .then((body) => {
        res.json({ userId, ...body });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `redis read failed: ${message}` });
      });
  };

  /**
   * Read-through: the cached subscription, or the origin's answer written back through the index.
   * A failing origin is a 502 and leaves nothing in Redis.
   */
  getSubscription = (req: Request, res: Response): void => {
    const userId = req.params.userId;
    if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
      res.status(400).json({ error: "userId must match ^u_\\d{7}$" });
      return;
    }
    const includeAddons = req.query.includeAddons;
    if (includeAddons !== undefined && includeAddons !== "true" && includeAddons !== "false") {
      res.status(400).json({ error: "includeAddons must be true or false" });
      return;
    }

    void this.readSubscription(userId, includeAddons === "true")
      .then((body) => {
        res.json(body);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: message });
      });
  };

  /**
   * One entitlement read: SMEMBERS the entity's index set, then MGET the members. `latencyMs`
   * measures only the Redis round trip, per docs/API.md.
   *
   * `hit: false` with `variants: 0` after a user has been invalidated is the correct answer — it is
   * never treated as an error and there is no scan fallback.
   */
  private async readEntitlement(
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

  /** `latencyMs` is Redis only (GET, the fill's write, SCARD); origin time is `originMs`. */
  private async readSubscription(userId: string, includeAddons: boolean) {
    const { value: subscription, reads } = await captureReads(() =>
      this.subscriptions.getActiveSubscription(userId, { includeAddons }),
    );
    const read = reads[0];
    if (read === undefined) throw new Error("read-through reported no read");

    const started = process.hrtime.bigint();
    const variants = await this.redis.scard(this.index.indexKeyFor(TENANT, CATEGORY, userId));
    const scardMs = Number(process.hrtime.bigint() - started) / 1e6;

    return {
      userId,
      source: read.source,
      variants,
      latencyMs: read.redisMs + scardMs,
      ...(read.originMs !== undefined && read.source === "origin" ? { originMs: read.originMs } : {}),
      subscription,
    };
  }
}
