// The seeder — a small state machine that writes the deterministic fixture into Redis, inspecting
// every reply, and records a marker so a container restart does not reseed.
//
// Two paths write the same records (US-010). `bulk` pipelines ~20k commands per round trip — the only
// way 2M records land in about a minute. `lazy` fills each record through the @Cache decorator: one
// GET, one origin call and one MULTI per record, so it is capped at LAZY_MAX_KEYS. In both modes the
// first LAZY_WARM_USERS users — the eviction batch — are filled through the decorator as a final
// `lazy-warm` phase. See US-005.md, US-010.md and docs/REDIS-SCHEMA.md.

import { EventEmitter } from "node:events";

import type { EntityIndexCacheStrategy, Registration } from "@redis-hash-index/cache";
import {
  expectedTotals,
  generateUsers,
  OriginError,
  userCount,
  userIdFor,
  variantsFor,
  type ExpectedTotals,
} from "@redis-hash-index/fixture";

import { CACHE_TTL_SECONDS, CATEGORY, MARKER_KEY, TENANT, type SeedMode } from "./config";

export type SeedState = "idle" | "seeding" | "ready" | "failed";

/** `bulk` / `lazy` is the main fill; `lazy-warm` is the decorator fill of the eviction batch. */
export type SeedPhase = SeedMode | "lazy-warm";

export interface SeedStatus {
  state: SeedState;
  /** SEED_KEYS — the requested cache-record count. */
  targetKeys: number;
  seedMode: SeedMode;
  /** The phase running now, or the last one that ran. Absent before any seed. */
  phase?: SeedPhase;
  /** Records the origin refused to produce during a decorator fill (e.g. ORIGIN_FAIL_USER). Never cached. */
  originFailures: number;
  users: number;
  cacheKeys: number;
  indexKeys: number;
  /** 0..1. `1` once the fixture is fully written. */
  progress: number;
  seedValue: number;
  /** `used_memory_human` from `INFO memory`, or `"0"` if unavailable. */
  memoryHuman: string;
  error?: string;
}

export interface SeedProgressFrame {
  t: "seed-progress";
  done: number;
  total: number;
  percent: number;
  phase?: SeedPhase;
}

export interface SeedMarker {
  seedValue: number;
  targetKeys: number;
  seedMode: SeedMode;
  originFailures: number;
  users: number;
  cacheKeys: number;
  indexKeys: number;
  completedAt: string;
}

/** The slice of a Redis client the seeder touches. */
export interface SeederRedis {
  dbsize(): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  flushdb(): Promise<unknown>;
  info(section: string): Promise<string>;
}

export interface SeederConfig {
  seedKeys: number;
  seedValue: number;
  pipelineSize: number;
  seedMode: SeedMode;
  lazyConcurrency: number;
  lazyMaxKeys: number;
  lazyWarmUsers: number;
}

/** Per-seed overrides of the container's SEED_MODE / SEED_KEYS (`POST /api/seed` body). */
export interface SeedOverrides {
  seedMode?: SeedMode;
  seedKeys?: number;
}

/** The decorated read the lazy paths fill through — `SubscriptionService` in production. */
export interface LazyFiller {
  getActiveSubscription(userId: string, params: { v: number }): Promise<unknown>;
}

export class AlreadySeedingError extends Error {
  constructor() {
    super("a seed is already in progress");
    this.name = "AlreadySeedingError";
  }
}

/** A seed request refused before anything was flushed — e.g. `lazy` above LAZY_MAX_KEYS. */
export class SeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRefusedError";
  }
}

/** Emits `progress` ({@link SeedProgressFrame}), `done` ({@link SeedMarker}) and `failed` (string). */
export class Seeder extends EventEmitter {
  private state: SeedState = "idle";
  private done = 0;
  private total = 0;
  private expected: ExpectedTotals = { users: 0, cacheKeys: 0, indexKeys: 0 };
  private error: string | undefined;
  private seedKeys: number;
  private seedMode: SeedMode;
  private phase: SeedPhase | undefined;
  private originFailures = 0;

  constructor(
    private readonly redis: SeederRedis,
    private readonly index: EntityIndexCacheStrategy,
    private readonly filler: LazyFiller,
    private readonly config: SeederConfig,
  ) {
    super();
    this.seedKeys = config.seedKeys;
    this.seedMode = config.seedMode;
  }

  /** Load a marker left by a previous completed seed so status reports `ready` after a restart. */
  async init(): Promise<void> {
    const raw = await this.redis.get(MARKER_KEY);
    if (raw === null) return;
    let marker: SeedMarker;
    try {
      marker = JSON.parse(raw) as SeedMarker;
    } catch {
      return; // a corrupt marker just means "not seeded" — a reseed will overwrite it
    }
    this.state = "ready";
    this.seedKeys = marker.targetKeys;
    this.seedMode = marker.seedMode ?? "bulk";
    this.originFailures = marker.originFailures ?? 0;
    this.expected = {
      users: marker.users,
      cacheKeys: marker.cacheKeys,
      indexKeys: marker.indexKeys,
    };
    this.total = marker.cacheKeys + marker.indexKeys;
    this.done = this.total;
  }

  isSeeding(): boolean {
    return this.state === "seeding";
  }

  /** True once a completed fixture is in Redis (fresh seed or a marker loaded at boot). */
  isReady(): boolean {
    return this.state === "ready";
  }

  /** Distinct users in the current/last fixture; 0 until a seed completes. Used by the run driver. */
  get seededUserCount(): number {
    return this.expected.users;
  }

  /**
   * Begin seeding in the background. Throws {@link AlreadySeedingError} if one is already running and
   * {@link SeedRefusedError} — before touching Redis — if `lazy` is asked for more than LAZY_MAX_KEYS.
   */
  start(overrides: SeedOverrides = {}): void {
    if (this.state === "seeding") throw new AlreadySeedingError();
    const seedMode = overrides.seedMode ?? this.config.seedMode;
    const seedKeys = overrides.seedKeys ?? this.config.seedKeys;
    if (seedMode === "lazy" && seedKeys > this.config.lazyMaxKeys) {
      throw new SeedRefusedError(
        `SEED_MODE=lazy refuses SEED_KEYS=${seedKeys}: above LAZY_MAX_KEYS=${this.config.lazyMaxKeys} ` +
          "(a lazy fill is one origin call and one MULTI per record) — use SEED_MODE=bulk or raise LAZY_MAX_KEYS",
      );
    }
    this.state = "seeding";
    this.seedKeys = seedKeys;
    this.seedMode = seedMode;
    this.phase = undefined;
    this.originFailures = 0;
    this.done = 0;
    this.error = undefined;
    this.expected = expectedTotals(seedKeys, this.config.seedValue);
    this.total = this.expected.cacheKeys + this.expected.indexKeys;
    void this.run();
  }

  /** Flush the database and clear the marker. Refuses while seeding. */
  async reset(): Promise<void> {
    if (this.state === "seeding") throw new AlreadySeedingError();
    await this.redis.flushdb();
    this.state = "idle";
    this.done = 0;
    this.total = 0;
    this.expected = { users: 0, cacheKeys: 0, indexKeys: 0 };
    this.error = undefined;
    this.phase = undefined;
    this.originFailures = 0;
    this.emit("progress", this.progressFrame());
  }

  progressFrame(): SeedProgressFrame {
    const total = this.total;
    const percent = total === 0 ? 0 : Math.min(1, this.done / total);
    return {
      t: "seed-progress",
      done: this.done,
      total,
      percent,
      ...(this.phase !== undefined ? { phase: this.phase } : {}),
    };
  }

  async status(): Promise<SeedStatus> {
    let memoryHuman = "0";
    try {
      const info = await this.redis.info("memory");
      memoryHuman = /used_memory_human:(\S+)/.exec(info)?.[1] ?? "0";
    } catch {
      // status must never throw just because INFO was unavailable
    }
    return {
      state: this.state,
      targetKeys: this.seedKeys,
      seedMode: this.seedMode,
      ...(this.phase !== undefined ? { phase: this.phase } : {}),
      originFailures: this.originFailures,
      users: this.expected.users,
      cacheKeys: this.expected.cacheKeys,
      indexKeys: this.expected.indexKeys,
      progress: this.total === 0 ? 0 : Math.min(1, this.done / this.total),
      seedValue: this.config.seedValue,
      memoryHuman,
      ...(this.error !== undefined ? { error: this.error } : {}),
    };
  }

  private async run(): Promise<void> {
    // Emit progress at least once a second — silence during a multi-minute 10M seed reads as a hang.
    const ticker = setInterval(() => {
      this.emit("progress", this.progressFrame());
    }, 1000);
    ticker.unref();

    try {
      this.emit("progress", this.progressFrame());
      // Start from a clean slate so the DBSIZE assertion is exact and a reseed is deterministic.
      await this.redis.flushdb();

      const users = userCount(this.seedKeys);
      const warmUsers = Math.min(this.config.lazyWarmUsers, users);

      this.enterPhase(this.seedMode, users - warmUsers);
      if (this.seedMode === "bulk") {
        await this.fillBulk(warmUsers);
      } else {
        await this.fillLazy(warmUsers, users);
      }

      this.enterPhase("lazy-warm", warmUsers);
      await this.fillLazy(0, warmUsers);

      const dbsize = await this.redis.dbsize();
      const expectedDbsize = this.expected.cacheKeys + this.expected.indexKeys;
      if (dbsize !== expectedDbsize) {
        throw new Error(
          `post-seed DBSIZE ${dbsize} does not match expected ${expectedDbsize} ` +
            `(${this.expected.cacheKeys} cache + ${this.expected.indexKeys} index` +
            `${this.originFailures > 0 ? `, after ${this.originFailures} origin failures` : ""})`,
        );
      }

      const marker: SeedMarker = {
        seedValue: this.config.seedValue,
        targetKeys: this.seedKeys,
        seedMode: this.seedMode,
        originFailures: this.originFailures,
        users: this.expected.users,
        cacheKeys: this.expected.cacheKeys,
        indexKeys: this.expected.indexKeys,
        completedAt: new Date().toISOString(),
      };
      await this.redis.set(MARKER_KEY, JSON.stringify(marker));

      this.done = this.total;
      this.state = "ready";
      this.emit("progress", this.progressFrame());
      console.log(`[benchmark] seed ready: ${this.expected.cacheKeys} cache + ${this.expected.indexKeys} index keys`);
      this.emit("done", marker);
    } catch (err) {
      this.state = "failed";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit("failed", this.error);
    } finally {
      clearInterval(ticker);
    }
  }

  private enterPhase(phase: SeedPhase, users: number): void {
    this.phase = phase;
    const how = phase === "bulk" ? "pipelined" : `through @Cache, concurrency ${this.config.lazyConcurrency}`;
    console.log(`[benchmark] seed phase ${phase}: ${users} users ${how}`);
    this.emit("progress", this.progressFrame());
  }

  /** Users `fromUser..` written by the shared writer in pipelined transactions. */
  private async fillBulk(fromUser: number): Promise<void> {
    let records: Registration[] = [];
    let queuedUsers = 0;
    const flush = async (): Promise<void> => {
      if (records.length === 0) return;
      await this.index.registerMany(records);
      this.done += records.length + queuedUsers;
      records = [];
      queuedUsers = 0;
    };

    const indexKeyFor = (userId: string): string => this.index.indexKeyFor(TENANT, CATEGORY, userId);

    for (const user of generateUsers(this.seedKeys, this.config.seedValue, indexKeyFor, fromUser)) {
      for (const record of user.records) {
        records.push({ ...record, ttlSeconds: CACHE_TTL_SECONDS });
      }
      queuedUsers += 1;
      // Four commands per record. The shared writer further bounds each transaction.
      if (records.length * 4 >= this.config.pipelineSize) await flush();
    }
    await flush();
  }

  /**
   * Users `fromUser..toUser-1`, every variant filled by calling the decorated read. An {@link OriginError}
   * skips that record — the decorator wrote nothing, and the expected totals shrink to match. Any other
   * error (a Redis write failing inside the decorator) aborts the seed.
   */
  private async fillLazy(fromUser: number, toUser: number): Promise<void> {
    let next = fromUser;
    let aborted = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (aborted || i >= toUser) return;
        const userId = userIdFor(i);
        const variants = variantsFor(i, this.config.seedValue);
        let filled = 0;
        for (let v = 1; v <= variants; v += 1) {
          try {
            await this.filler.getActiveSubscription(userId, { v });
            filled += 1;
          } catch (err) {
            if (!(err instanceof OriginError)) {
              aborted = true; // stop the other workers writing into a seed that has already failed
              throw err;
            }
            this.originFailures += 1;
            this.expected.cacheKeys -= 1;
            console.warn(`[benchmark] origin failed for ${userId} v${v}, nothing cached: ${err.message}`);
          }
          this.done += 1;
        }
        // An index set exists only if at least one of the user's records was written.
        if (filled === 0) this.expected.indexKeys -= 1;
        this.done += 1;
      }
    };
    const workers = Math.min(this.config.lazyConcurrency, Math.max(0, toUser - fromUser));
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }
}
