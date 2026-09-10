// packages/cache — the shared entity index.
//
// `test-api` reads through this index and `webhook` invalidates through it. They import this one
// module so a key can never be built two different ways. See docs/REDIS-SCHEMA.md — it is the
// contract, this file is its only implementation.

/**
 * The narrow slice of a Redis client this module needs. Declaring it here (rather than depending on
 * ioredis's types everywhere) keeps the module testable and honest about what it touches.
 */
export interface RedisClient {
  smembers(key: string): Promise<string[]>;
  sscan(key: string, cursor: string, count: "COUNT", size: number): Promise<[string, string[]]>;
  srem(key: string, ...members: string[]): Promise<number>;
  unlink(...keys: string[]): Promise<number>;
  multi(): RedisMulti;
  pipeline(): RedisPipeline;
}

/** A `MULTI` chain. `exec()` yields one `[error, reply]` tuple per queued command, or `null` on abort. */
export interface RedisMulti {
  set(key: string, value: string, mode: "EX", seconds: number): RedisMulti;
  sadd(key: string, member: string): RedisMulti;
  expire(key: string, seconds: number, mode: "NX" | "GT"): RedisMulti;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/** A pipeline (no transaction). Same reply shape as {@link RedisMulti}. */
export interface RedisPipeline {
  exists(key: string): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface EntityIndexOptions {
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

/** Index key prefix. Distinct from any `service` so `parse` can never confuse the two. */
export const INDEX_PREFIX = "entityIndex";

const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const KEY_DELIMITER = "::";
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 2_592_000; // 30 days

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TTL_SECONDS = 3600;

export class EntityIndex {
  private readonly redis: RedisClient;
  private readonly categories: ReadonlySet<string>;
  readonly ttlSeconds: number;
  readonly batchSize: number;
  readonly concurrency: number;

  constructor(redis: RedisClient, options: EntityIndexOptions) {
    this.redis = redis;
    this.categories = new Set(options.categories);
    if (this.categories.size === 0) {
      throw new Error("EntityIndex requires at least one category");
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
    const service = parts[0];
    const tenant = parts[1];
    const entity = parts[2];
    const entityId = parts[3];
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
    return (await this.registerMany([{ cacheKey, ttlSeconds }])) === 1;
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

function assertSegment(name: string, value: string): void {
  if (typeof value !== "string" || !SEGMENT_RE.test(value)) {
    throw new Error(`invalid ${name} segment: ${JSON.stringify(value)}`);
  }
}

function assertValidTtl(ttlSeconds: number): void {
  if (
    typeof ttlSeconds !== "number" ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_TTL_SECONDS ||
    ttlSeconds > MAX_TTL_SECONDS
  ) {
    throw new RangeError(
      `ttlSeconds must be a whole number in ${MIN_TTL_SECONDS}..${MAX_TTL_SECONDS}, got ${String(ttlSeconds)}`,
    );
  }
}

/** Split `items` into consecutive slices of at most `size`. Empty input yields nothing. */
function* chunk<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
