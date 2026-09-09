// services/benchmark — the demo's control plane: the seeder API now, the run driver (US-006) and
// the live UI (US-007) later. It is the only service that writes the fixture.
//
// `POST /api/seed` returns 202 and seeds in the background; `GET /api/seed/status` and the `/ws`
// WebSocket both report progress. See docs/API.md.

import express, { type Express, type Request, type Response } from "express";

import { AlreadySeedingError, type Seeder } from "./seeder";

export interface BenchmarkDeps {
  seeder: Seeder;
}

export function createApp(deps: BenchmarkDeps): Express {
  const { seeder } = deps;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // The single-page UI lands in US-007; until then this keeps `GET /` from 404-ing.
  app.get("/", (_req: Request, res: Response) => {
    res.type("text/plain").send("benchmark UI — see US-007. API: /api/seed, /api/seed/status\n");
  });

  app.get("/api/seed/status", (_req: Request, res: Response) => {
    void seeder
      .status()
      .then((status) => res.json(status))
      .catch((err: unknown) => {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/seed", (_req: Request, res: Response) => {
    if (seeder.isSeeding()) {
      res.status(409).json({ error: "a seed is already in progress" });
      return;
    }
    try {
      seeder.start();
    } catch (err) {
      if (err instanceof AlreadySeedingError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    res.status(202).json({ state: "seeding" });
  });

  app.post("/api/seed/reset", (_req: Request, res: Response) => {
    if (seeder.isSeeding()) {
      res.status(409).json({ error: "cannot reset while a seed is in progress" });
      return;
    }
    void seeder
      .reset()
      .then(() => res.json({ state: "idle" }))
      .catch((err: unknown) => {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  return app;
}
