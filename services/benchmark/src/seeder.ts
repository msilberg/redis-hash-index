// The seeder — a small state machine that writes the deterministic fixture into Redis in pipelined
// batches, inspecting every reply, and records a marker so a container restart does not reseed.
// See US-005.md and docs/REDIS-SCHEMA.md.

import { EventEmitter } from "node:events";

import type { EntityIndex, Registration } from "@redis-hash-index/cache";

import { CACHE_TTL_SECONDS, CATEGORY, MARKER_KEY, TENANT } from "./config";
import { expectedTotals, generateUsers, type ExpectedTotals } from "./fixture";

export type SeedState = "idle" | "seeding" | "ready" | "failed";

export interface SeedStatus {
  state: SeedState;
  /** SEED_KEYS — the requested cache-record count. */
  targetKeys: number;
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
}

export interface SeedMarker {
  seedValue: number;
  targetKeys: number;
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
}

export class AlreadySeedingError extends Error {
  constructor() {
    super("a seed is already in progress");
    this.name = "AlreadySeedingError";
  }
}

/** Emits `progress` ({@link SeedProgressFrame}), `done` ({@link SeedMarker}) and `failed` (string). */
export class Seeder extends EventEmitter {
  private state: SeedState = "idle";
  private done = 0;
  private total = 0;
  private expected: ExpectedTotals = { users: 0, cacheKeys: 0, indexKeys: 0 };
  private error: string | undefined;

  constructor(
    private readonly redis: SeederRedis,
    private readonly index: EntityIndex,
    private readonly config: SeederConfig,
  ) {
    super();
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

  /** Begin seeding in the background. Throws {@link AlreadySeedingError} if one is already running. */
  start(): void {
    if (this.state === "seeding") throw new AlreadySeedingError();
    this.state = "seeding";
    this.done = 0;
    this.error = undefined;
    this.expected = expectedTotals(this.config.seedKeys, this.config.seedValue);
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
    this.emit("progress", this.progressFrame());
  }

  progressFrame(): SeedProgressFrame {
    const total = this.total;
    const percent = total === 0 ? 0 : Math.min(1, this.done / total);
    return { t: "seed-progress", done: this.done, total, percent };
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
      targetKeys: this.config.seedKeys,
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

      let records: Registration[] = [];
      let queuedUsers = 0;
      const flush = async (): Promise<void> => {
        if (records.length === 0) return;
        await this.index.registerMany(records);
        this.done += records.length + queuedUsers;
        records = [];
        queuedUsers = 0;
      };

      const indexKeyFor = (userId: string): string =>
        this.index.indexKeyFor(TENANT, CATEGORY, userId);

      for (const user of generateUsers(this.config.seedKeys, this.config.seedValue, indexKeyFor)) {
        for (const record of user.records) {
          records.push({ ...record, ttlSeconds: CACHE_TTL_SECONDS });
        }
        queuedUsers += 1;
        // Four commands per record. The shared writer further bounds each transaction.
        if (records.length * 4 >= this.config.pipelineSize) await flush();
      }
      await flush();

      const dbsize = await this.redis.dbsize();
      const expectedDbsize = this.expected.cacheKeys + this.expected.indexKeys;
      if (dbsize !== expectedDbsize) {
        throw new Error(
          `post-seed DBSIZE ${dbsize} does not match expected ${expectedDbsize} ` +
            `(${this.expected.cacheKeys} cache + ${this.expected.indexKeys} index)`,
        );
      }

      const marker: SeedMarker = {
        seedValue: this.config.seedValue,
        targetKeys: this.config.seedKeys,
        users: this.expected.users,
        cacheKeys: this.expected.cacheKeys,
        indexKeys: this.expected.indexKeys,
        completedAt: new Date().toISOString(),
      };
      await this.redis.set(MARKER_KEY, JSON.stringify(marker));

      this.done = this.total;
      this.state = "ready";
      this.emit("progress", this.progressFrame());
      this.emit("done", marker);
    } catch (err) {
      this.state = "failed";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit("failed", this.error);
    } finally {
      clearInterval(ticker);
    }
  }
}
