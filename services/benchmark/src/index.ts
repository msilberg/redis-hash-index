import { createServer } from "node:http";

import Redis from "ioredis";
import { EntityIndex, type RedisClient } from "@redis-hash-index/cache";

import { createApp } from "./app";
import { CATEGORY, loadConfig } from "./config";
import { Seeder, type SeederRedis } from "./seeder";
import { attachWebSocket } from "./ws";

async function main(): Promise<void> {
  const config = loadConfig();

  // benchmark opens its OWN Redis connection — never shared with test-api or webhook. See docs/API.md.
  const redis = new Redis(config.redisUrl);
  redis.on("error", (err: Error) => {
    console.error(`[benchmark] redis error: ${err.message}`);
  });

  const index = new EntityIndex(redis as unknown as RedisClient, { categories: [CATEGORY] });
  const seeder = new Seeder(redis as unknown as SeederRedis, index, {
    seedKeys: config.seedKeys,
    seedValue: config.seedValue,
    pipelineSize: config.pipelineSize,
  });
  await seeder.init();

  const app = createApp({ seeder });
  const server = createServer(app);
  const hub = attachWebSocket(server, seeder);

  server.listen(config.port, () => {
    console.log(`[benchmark] listening on :${config.port} (seedKeys=${config.seedKeys})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[benchmark] ${signal} received, shutting down`);
    void hub.close().finally(() => {
      server.close(() => {
        void redis.quit().finally(() => process.exit(0));
      });
    });
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
