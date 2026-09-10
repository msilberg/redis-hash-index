import express, { type Express } from "express";
import { WebhookController, type WebhookRedis } from "./controller";

export type { Job, JobMode, JobState, WebhookRedis } from "./controller";

export function createApp(redis: WebhookRedis): Express {
  const controller = new WebhookController(redis);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/health", controller.health);
  app.post("/v1/invalidate", controller.startJobV1);
  app.post("/v2/invalidate", controller.startJobV2);
  app.get("/jobs/:jobId", controller.getJob);
  app.post("/jobs/:jobId/stop", controller.stopJob);

  return app;
}
