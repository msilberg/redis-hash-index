import type { SubscriptionOrigin } from "@redis-hash-index/fixture";
import express, { type Express } from "express";
import { TestApiController, type RedisReader } from "./controller";

export type { RedisReader } from "./controller";

/** `configureCache` must already have run in this process — `/subscription` fills through `@Cache`. */
export function createApp(redis: RedisReader, origin: SubscriptionOrigin): Express {
  const controller = new TestApiController(redis, origin);
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", controller.health);
  app.get("/entitlement/:userId", controller.getEntitlement);
  app.get("/subscription/:userId", controller.getSubscription);

  return app;
}
