import express, { type Express } from "express";
import { TestApiController, type RedisReader } from "./controller";

export type { RedisReader } from "./controller";

export function createApp(redis: RedisReader): Express {
  const controller = new TestApiController(redis);
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", controller.health);
  app.get("/entitlement/:userId", controller.getEntitlement);

  return app;
}
