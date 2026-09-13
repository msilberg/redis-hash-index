// The narrow Redis surface shared by every cache strategy. See docs/REDIS-SCHEMA.md.

/**
 * The narrow slice of a Redis client this module needs. Declaring it here (rather than depending on
 * ioredis's types everywhere) keeps the module testable and honest about what it touches.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
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
