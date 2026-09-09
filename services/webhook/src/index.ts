import Redis from "ioredis";
import { createApp, type WebhookRedis } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();

// webhook opens its OWN Redis connection — never shared with test-api or benchmark. See docs/API.md.
const redis = new Redis(config.redisUrl);

redis.on("error", (err: Error) => {
  console.error(`[webhook] redis error: ${err.message}`);
});

const app = createApp(redis as unknown as WebhookRedis);

const server = app.listen(config.port, () => {
  console.log(`[webhook] listening on :${config.port}`);
});

function shutdown(signal: string): void {
  console.log(`[webhook] ${signal} received, shutting down`);
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
