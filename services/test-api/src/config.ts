// Static pieces of the Redis schema this service is pinned to. `demo` is the only tenant and
// `activeSubscription` the only indexed category — see docs/REDIS-SCHEMA.md.
export const TENANT = "demo";
export const CATEGORY = "activeSubscription";

export interface Config {
  port: number;
  redisUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? "3001");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PORT: ${JSON.stringify(env.PORT)}`);
  }
  return {
    port,
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
  };
}
