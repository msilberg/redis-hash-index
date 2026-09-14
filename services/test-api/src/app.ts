import express, { type Express } from "express";
import { TestApiController, type RedisReader } from "./controller";
import type { SubscriptionOrigin } from "./subscription-service";

export type { RedisReader } from "./controller";

/** `configureCache` must already have run in this process — `/subscription` fills through `@Cache`. */
export function createApp(redis: RedisReader, origin: SubscriptionOrigin): Express {
  const controller = new TestApiController(redis, origin);
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", controller.health);
  app.get("/subscription/:userId", controller.getSubscription);

  return app;
}
