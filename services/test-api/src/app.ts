import express, { type Express } from "express";
import { TestApiController, type TestApiRedis } from "./controller";
import type { BillingOrigin } from "./origin";

export type { TestApiRedis } from "./controller";

export function createApp(redis: TestApiRedis, origin: BillingOrigin): Express {
  const controller = new TestApiController(redis, origin);
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", controller.health);
  app.get("/entitlement/:userId", controller.getEntitlement);
  app.get("/subscription/:userId", controller.getSubscription);

  return app;
}
