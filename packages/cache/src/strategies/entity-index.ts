// The entity-index cache strategy.
//
// `test-api` reads through this index and `webhook` invalidates through it. They import this one
// module so a key can never be built two different ways. See docs/REDIS-SCHEMA.md — it is the
// contract, this file is its only implementation.

import {
  assertSegment,
  assertValidTtl,
  chunk,
  INDEX_PREFIX,
  KEY_DELIMITER,
  SEGMENT_RE,
} from "../keys";
import type { RedisClient } from "../redis";
import { DefaultCacheStrategy } from "./default";

export interface EntityIndexCacheStrategyOptions {
  /** Categories this index is responsible for; a key in any other category is not ours. */
  categories: Iterable<string>;
  /** Default TTL, in whole seconds. Only a convenience for callers — `register` still takes one explicitly. */
  ttlSeconds?: number;
  /** Max registrations per transaction and keys per multi-key command (`UNLINK`, `SREM`, pipelined `EXISTS`). */
  batchSize?: number;
  /** How many entities `invalidateEntities` works on at once. */
  concurrency?: number;
}

export interface ParsedCacheKey {
  service: string;
  tenant: string;
  entity: string;
  entityId: string;
  /** Opaque variant tail — never interpreted, only carried. */
  params: string;
  /** The index set this cache key belongs to. */
  indexKey: string;
}

export interface Registration {
  cacheKey: string;
  ttlSeconds: number;
  /** When supplied, SET EX runs in the same transaction as registration. */
  value?: string;
}

export interface EntityFailure {
  entityId: string;
  error: string;
}

export interface InvalidationResult {
  /** Entities successfully completed; failed entities are listed in incomplete. */
  entities: number;
  /** Total members read across every entity's `SMEMBERS`. */
  membersObserved: number;
  /** Sum of `UNLINK` replies — cache values actually removed. */
  valuesUnlinked: number;
  /** Sum of `SREM` replies — index references actually removed. */
  referencesRemoved: number;
  incomplete: EntityFailure[];
}

export interface PruneResult {
  indexKey: string;
  /** Scan observations, possibly including duplicates (SSCAN is not a snapshot). */
  membersChecked: number;
  /** References dropped because their cache value no longer exists. */
  membersRemoved: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TTL_SECONDS = 3600;

export class EntityIndexCacheStrategy extends DefaultCacheStrategy {
  private readonly categories: ReadonlySet<string>;
  readonly ttlSeconds: number;
  readonly batchSize: number;
  readonly concurrency: number;

  constructor(redis: RedisClient, options: EntityIndexCacheStrategyOptions) {
    super(redis);
    this.categories = new Set(options.categories);
    if (this.categories.size === 0) {
      throw new Error("EntityIndexCacheStrategy requires at least one category");
    }
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new Error(`batchSize must be a positive integer, got ${String(this.batchSize)}`);
    }
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error(`concurrency must be a positive integer, got ${String(this.concurrency)}`);
    }
  }

  /**
   * Write a cache value and register it in its entity's index.
   *
   * Deliberately does NOT call `super.set()` on the indexed path. `super.set()` followed by a
   * separate registration is two round trips, and an invalidation landing between them would never
   * see the value — it would survive to its TTL with no reference pointing at it. `registerMany`
   * queues `SET EX`, `SADD`, `EXPIRE NX` and `EXPIRE GT` in one `MULTI`, so the value and its
   * reference land together. A key in a category this strategy does not own is a plain `SET`.
   */
  override async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.parse(key) === null) {
      await super.set(key, value, ttlSeconds);
      return;
    }
    await this.registerMany([{ cacheKey: key, value, ttlSeconds }]);
  }

  /** Build the index set key for one entity. Throws if any segment is not `[A-Za-z0-9_.-]+`. */
  indexKeyFor(tenant: string, category: string, entityId: string): string {
    assertSegment("tenant", tenant);
    assertSegment("category", category);
    assertSegment("entityId", entityId);
    if (!this.categories.has(category)) {
      throw new Error(`unknown category: ${category}`);
    }
    return [INDEX_PREFIX, tenant, category, entityId].join(KEY_DELIMITER);
  }

  /**
   * Structural parse of a cache key. Returns `null` — never throws — when the string is not a
   * cache key for one of this index's categories.
   */
  parse(cacheKey: string): ParsedCacheKey | null {
    const parts = cacheKey.split(KEY_DELIMITER);
    if (parts.length < 5) return null;
    const [service, tenant, entity, entityId] = parts;
    const params = parts.slice(4).join(KEY_DELIMITER);
    if (
      service === undefined ||
      tenant === undefined ||
      entity === undefined ||
      entityId === undefined ||
      params.length === 0
    ) {
      return null;
    }
    if (
      !SEGMENT_RE.test(service) ||
      !SEGMENT_RE.test(tenant) ||
      !SEGMENT_RE.test(entity) ||
      !SEGMENT_RE.test(entityId)
    ) {
      return null;
    }
    if (!this.categories.has(entity)) return null;
    return {
      service,
      tenant,
      entity,
      entityId,
      params,
      indexKey: [INDEX_PREFIX, tenant, entity, entityId].join(KEY_DELIMITER),
    };
  }

  /**
   * Record a cache key under its entity's index and (re-)arm the index TTL.
   *
   * One `MULTI`: `SADD`, then `EXPIRE ttl NX` (establish — a fresh set is persistent), then
   * `EXPIRE ttl GT` (extend, never shorten). Every reply tuple is inspected because Redis does
   * not roll back a command that fails at runtime.
   *
   * @returns `true` if the member was newly added, `false` if it was already present.
   */
  async register(cacheKey: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.registerMany([{ cacheKey, ttlSeconds }]);
    return result === 1;
  }

  /**
   * Register a batch using the same NX/GT rule as register(). Optional values are written with
   * SET EX inside the transaction, closing the write/registration interleaving window.
   * Validate the entire input before writes, then pipeline at most batchSize records per MULTI.
   * Returns the count of newly added references. Runtime Redis errors do not roll back writes;
   * callers must treat a rejection as potentially partial and retry or rebuild their fixture.
   */
  async registerMany(records: readonly Registration[]): Promise<number> {
    const validated = records.map((record) => {
      assertValidTtl(record.ttlSeconds);
      const parsed = this.parse(record.cacheKey);
      if (parsed === null) {
        throw new Error(`not a valid cache key for this index: ${record.cacheKey}`);
      }
      return { ...record, indexKey: parsed.indexKey };
    });

    let added = 0;
    for (const batch of chunk(validated, this.batchSize)) {
      const multi = this.redis.multi();
      const addOffsets: number[] = [];
      let commands = 0;
      for (const { cacheKey, indexKey, ttlSeconds, value } of batch) {
        if (value !== undefined) {
          multi.set(cacheKey, value, "EX", ttlSeconds);
          commands += 1;
        }
        addOffsets.push(commands);
        multi.sadd(indexKey, cacheKey);
        multi.expire(indexKey, ttlSeconds, "NX");
        multi.expire(indexKey, ttlSeconds, "GT");
        commands += 3;
      }
      const replies = await multi.exec();
      if (replies === null) throw new Error("MULTI aborted while registering cache keys");
      if (replies.length !== commands) {
        throw new Error(`expected ${commands} replies from register MULTI, got ${replies.length}`);
      }
      for (const [err] of replies) {
        if (err) throw err;
      }
      for (const offset of addOffsets) {
        if (replies[offset]?.[1] === 1) added += 1;
      }
    }
    return added;
  }

  /**
   * Delete the cache for a set of entities through the index.
   *
   * Per entity, in this order: `SMEMBERS` → `UNLINK` the values (batched) → `SREM` the members we
   * observed (batched). Values before references, so an interrupted or failed run leaves the index
   * still listing exactly what remains to delete and the same call retried finishes it.
   *
   * Every recorded member is deleted unconditionally — no timestamp check. Deleting an absent key
   * is free; skipping a live one because a clock ran fast is a correctness bug.
   * Per-entity Redis errors are collected in incomplete; other entities continue. Counters include
   * acknowledged commands from partially completed entities. Invalid coordinates reject before I/O.
   */
  async invalidateEntities(
    tenant: string,
    category: string,
    entityIds: readonly string[],
  ): Promise<InvalidationResult> {
    const entities = entityIds.map((entityId) => ({
      entityId,
      indexKey: this.indexKeyFor(tenant, category, entityId),
    }));
    const result: InvalidationResult = {
      entities: 0,
      membersObserved: 0,
      valuesUnlinked: 0,
      referencesRemoved: 0,
      incomplete: [],
    };
    let next = 0;
    const workerCount = Math.min(this.concurrency, entities.length);

    const runWorker = async (): Promise<void> => {
      for (;;) {
        const entity = entities[next++];
        if (entity === undefined) return;
        try {
          await this.invalidateOne(entity.indexKey, result);
          result.entities += 1;
        } catch (err) {
          result.incomplete.push({
            entityId: entity.entityId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return result;
  }

  private async invalidateOne(indexKey: string, result: InvalidationResult): Promise<void> {
    const members = await this.redis.smembers(indexKey);
    result.membersObserved += members.length;
    for (const batch of chunk(members, this.batchSize)) {
      // Use a local reply before +=: concurrent workers must not overwrite another's update.
      const removed = await this.redis.unlink(...batch);
      result.valuesUnlinked += removed;
    }
    for (const batch of chunk(members, this.batchSize)) {
      const removed = await this.redis.srem(indexKey, ...batch);
      result.referencesRemoved += removed;
    }
  }

  /**
   * Drop index references whose cache value has already expired or been deleted out from under
   * the index. Never deletes the set itself. A maintenance operation, not part of the delete path.
   */
  async prune(tenant: string, category: string, entityId: string): Promise<PruneResult> {
    const indexKey = this.indexKeyFor(tenant, category, entityId);
    let cursor = "0";
    let membersChecked = 0;
    let membersRemoved = 0;
    do {
      // COUNT is a hint, not a hard limit; chunk each page before EXISTS/SREM.
      const [nextCursor, members] = await this.redis.sscan(indexKey, cursor, "COUNT", this.batchSize);
      cursor = nextCursor;
      for (const batch of chunk(members, this.batchSize)) {
        const pipe = this.redis.pipeline();
        for (const member of batch) pipe.exists(member);
        const replies = await pipe.exec();
        if (replies === null || replies.length !== batch.length) {
          throw new Error(`incomplete EXISTS pipeline while pruning ${indexKey}`);
        }
        const missing: string[] = [];
        replies.forEach(([err, reply], i) => {
          if (err) throw err;
          if (reply === 0) {
            const member = batch[i];
            if (member !== undefined) missing.push(member);
          }
        });
        membersChecked += batch.length;
        if (missing.length > 0) membersRemoved += await this.redis.srem(indexKey, ...missing);
      }
    } while (cursor !== "0");
    return { indexKey, membersChecked, membersRemoved };
  }
}
