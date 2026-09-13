// The innocent bystander. It reads entitlements through the shared entity index and reports how
// long Redis took, so that when the webhook blocks the server on an O(N) keyspace enumeration we
// can watch it happen to a request that did nothing wrong.
//
// It reads via SMEMBERS then MGET only. It never enumerates the keyspace — not even on an admin
// route. See docs/REDIS-SCHEMA.md.
//
// `GET /subscription/:userId` is the read path (US-009, US-011): a read-through fill in front of
// mock-billing, done entirely by the `@Cache` decorator on `SubscriptionService`. This controller
// never builds a cache key for it.

import { EntityIndexCacheStrategy, type RedisClient } from "@redis-hash-index/cache";
import { CATEGORY, TENANT, type Subscription } from "@redis-hash-index/fixture";
import type { Request, Response } from "express";

import { SubscriptionService, type SubscriptionOrigin, type SubscriptionParams } from "./subscription-service";

const USER_ID_RE = /^u_\d{7}$/;
const VARIANT_RE = /^[1-9]\d{0,2}$/;

/** The slice of a Redis client this service touches directly. Fills go through `@Cache`. */
export interface RedisReader {
  smembers(key: string): Promise<string[]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
}

const elapsedMs = (started: bigint): number => Number(process.hrtime.bigint() - started) / 1e6;

export class TestApiController {
  private readonly index: EntityIndexCacheStrategy;

  constructor(
    private readonly redis: RedisReader,
    private readonly origin: SubscriptionOrigin,
  ) {
    this.index = new EntityIndexCacheStrategy(redis as unknown as RedisClient, { categories: [CATEGORY] });
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

    void this.readEntitlement(userId)
      .then((body) => {
        res.json({ userId, ...body });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `redis read failed: ${message}` });
      });
  };

  getSubscription = (req: Request, res: Response): void => {
    const userId = req.params.userId;
    if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
      res.status(400).json({ error: "userId must match ^u_\\d{7}$" });
      return;
    }
    const params = subscriptionParams(req.query);
    if (typeof params === "string") {
      res.status(400).json({ error: params });
      return;
    }

    void this.readSubscription(userId, params)
      .then((body) => {
        res.json(body);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `subscription read failed: ${message}` });
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
    userId: string,
  ): Promise<{ hit: boolean; variants: number; latencyMs: number }> {
    const indexKey = this.index.indexKeyFor(TENANT, CATEGORY, userId);
    const started = process.hrtime.bigint();
    const members = await this.redis.smembers(indexKey);
    const values = members.length > 0 ? await this.redis.mget(...members) : [];
    const latencyMs = elapsedMs(started);
    const variants = values.filter((value) => Boolean(value)).length;
    return { hit: variants > 0, variants, latencyMs };
  }

  /**
   * One read-through: the decorated call, then the entitlement read for the variant count.
   *
   * The service is built per request over a probe around the shared origin, so this request can tell
   * whether it reached the origin and for how long — the decorator itself reports neither.
   * `latencyMs` is the decorated call's wall time minus origin time, plus the entitlement read. A
   * request that joins another request's in-flight fill (single-flight) never calls the origin, so
   * it reports `source: "cache"` although it waited on that fill.
   */
  private async readSubscription(userId: string, params: SubscriptionParams): Promise<Record<string, unknown>> {
    let originMs: number | undefined;
    const probe: SubscriptionOrigin = {
      getActiveSubscription: (id, p) => {
        const started = process.hrtime.bigint();
        return this.origin.getActiveSubscription(id, p).finally(() => {
          originMs = elapsedMs(started);
        });
      },
    };

    const started = process.hrtime.bigint();
    const subscription: Subscription | null = await new SubscriptionService(probe).getActiveSubscription(
      userId,
      params,
    );
    const fillMs = elapsedMs(started) - (originMs ?? 0);
    const entitlement = await this.readEntitlement(userId);

    return {
      userId,
      source: originMs === undefined ? "cache" : "origin",
      variants: entitlement.variants,
      latencyMs: fillMs + entitlement.latencyMs,
      ...(originMs === undefined ? {} : { originMs }),
      subscription,
    };
  }
}

/**
 * The query string is NOT the key. `SubscriptionParams` is built field by field from the key contract
 * — today only `v` — and everything else (`include_addons`, tracking parameters, typos) is dropped, so
 * `?v=2` produces exactly the bulk seeder's `{"v":2}` key. Passing the raw query through would make a
 * stray parameter a different key: a permanent miss, and an invalidation that leaves it behind.
 * Returns an error message for a malformed value.
 */
function subscriptionParams(query: Request["query"]): SubscriptionParams | string {
  const params: SubscriptionParams = {};
  const { v } = query;
  if (v !== undefined) {
    if (typeof v !== "string" || !VARIANT_RE.test(v)) return "v must be a positive integer";
    params.v = Number(v);
  }
  return params;
}
