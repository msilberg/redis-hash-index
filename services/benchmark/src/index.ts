import { createServer } from "node:http";

import Redis from "ioredis";
import { EntityIndexCacheStrategy, type RedisClient } from "@redis-hash-index/cache";

import { createApp } from "./app";
import { CATEGORY, loadConfig } from "./config";
import { TestApiFiller } from "./lazy-filler";
import { Runner } from "./runner";
import { Seeder, type SeederRedis } from "./seeder";
import { attachWebSocket } from "./ws";

// A lazy fill waits on test-api, which waits on mock-billing (BILLING_TIMEOUT_MS, default 5 s).
const FILL_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();

  // benchmark opens its OWN Redis connection — never shared with test-api or webhook. See docs/API.md.
  // Only the bulk writer uses it to write; lazy fills go through test-api over HTTP.
  const redis = new Redis(config.redisUrl);
  redis.on("error", (err: Error) => {
    console.error(`[benchmark] redis error: ${err.message}`);
  });

  const filler = new TestApiFiller({
    testApiBaseUrl: config.testApiBaseUrl,
    mockBillingBaseUrl: config.mockBillingBaseUrl,
    timeoutMs: FILL_TIMEOUT_MS,
  });

  const index = new EntityIndexCacheStrategy(redis as unknown as RedisClient, { categories: [CATEGORY] });
  const seeder = new Seeder(redis as unknown as SeederRedis, index, filler, {
    seedKeys: config.seedKeys,
    seedValue: config.seedValue,
    pipelineSize: config.pipelineSize,
    seedMode: config.seedMode,
    lazyConcurrency: config.lazyConcurrency,
    lazyMaxKeys: config.lazyMaxKeys,
    lazyWarmUsers: config.lazyWarmUsers,
  });
  await seeder.init();

  const runner = new Runner(seeder, {
    testApiBaseUrl: config.testApiBaseUrl,
    webhookBaseUrl: config.webhookBaseUrl,
    pollIntervalMs: config.pollIntervalMs,
    batchDelayMs: config.batchDelayMs,
    batchUsers: config.batchUsers,
    pollTimeoutMs: config.pollTimeoutMs,
    historyCap: config.runHistoryCap,
  });

  const app = createApp({ seeder, runner });
  const server = createServer(app);
  const hub = attachWebSocket(server, seeder, runner);

  server.listen(config.port, () => {
    console.log(`[benchmark] listening on :${config.port} (seedKeys=${config.seedKeys} seedMode=${config.seedMode})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[benchmark] ${signal} received, shutting down`);
    void runner.stop().finally(() => hub.close()).finally(() => {
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
