import Redis from "ioredis";
import { createApp, type TestApiRedis } from "./app";
import { loadConfig } from "./config";
import { BillingOrigin } from "./origin";

const config = loadConfig();

// test-api opens its OWN Redis connection. It must never share a client with the webhook or
// benchmark services: the point of this service is to be genuinely queued behind a server-side
// scan, not to have the wait hidden inside another process's client-side command buffer.
const redis = new Redis(config.redisUrl);

redis.on("error", (err: Error) => {
  console.error(`[test-api] redis error: ${err.message}`);
});

const origin = new BillingOrigin({
  latencyMs: config.originLatencyMs,
  seedValue: config.seedValue,
  ...(config.originFailUser === undefined ? {} : { failUser: config.originFailUser }),
});

const app = createApp(redis as unknown as TestApiRedis, origin);

const server = app.listen(config.port, () => {
  console.log(`[test-api] listening on :${config.port} (origin latency ${config.originLatencyMs}ms)`);
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
