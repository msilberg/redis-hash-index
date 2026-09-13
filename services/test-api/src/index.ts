import { configureCache, type RedisClient } from "@redis-hash-index/cache";
import { BillingProvider, CATEGORY, SERVICE, TENANT } from "@redis-hash-index/fixture";
import Redis from "ioredis";
import { createApp, type RedisReader } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();

// test-api opens its OWN Redis connection. It must never share a client with the webhook or
// benchmark services: the point of this service is to be genuinely queued behind a server-side
// scan, not to have the wait hidden inside another process's client-side command buffer.
const redis = new Redis(config.redisUrl);

redis.on("error", (err: Error) => {
  console.error(`[test-api] redis error: ${err.message}`);
});

// The @Cache decorator behind GET /subscription resolves its strategies from this registry at call
// time. SERVICE is `test-api`, so a fill lands on exactly the key the fixture seeded.
configureCache({
  redis: redis as unknown as RedisClient,
  service: SERVICE,
  tenant: TENANT,
  categories: [CATEGORY],
});

const origin = new BillingProvider({
  seedValue: config.seedValue,
  latencyMs: config.originLatencyMs,
  failUser: config.originFailUser,
});

const app = createApp(redis as unknown as RedisReader, origin);

const server = app.listen(config.port, () => {
  console.log(`[test-api] listening on :${config.port}`);
});

function shutdown(signal: string): void {
  console.log(`[test-api] ${signal} received, shutting down`);
  server.close(() => {
    void redis.quit().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
