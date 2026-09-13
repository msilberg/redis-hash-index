// services/benchmark — the demo's control plane: the seeder API now, the run driver (US-006) and
// the live UI (US-007) later. It is the only service that writes the fixture.
//
// `POST /api/seed` returns 202 and seeds in the background; `GET /api/seed/status` and the `/ws`
// WebSocket both report progress. See docs/API.md.

import express, { type Express, type Request, type Response } from "express";

import { FixtureNotReadyError, RunInProgressError, type Runner } from "./runner";
import { AlreadySeedingError, SeedRefusedError, type SeedOverrides, type Seeder } from "./seeder";
import { UI_HTML } from "./ui";

export interface BenchmarkDeps {
  seeder: Seeder;
  runner: Runner;
}

export function createApp(deps: BenchmarkDeps): Express {
  const { seeder, runner } = deps;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // The live UI (US-007) — one self-contained page, served as a string so the Dockerfile needs no
  // extra copy step. See src/ui.ts.
  app.get("/", (_req: Request, res: Response) => {
    res.type("html").send(UI_HTML);
  });

  app.get("/api/seed/status", (_req: Request, res: Response) => {
    void seeder
      .status()
      .then((status) => res.json(status))
      .catch((err: unknown) => {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/seed", (req: Request, res: Response) => {
    if (seeder.isSeeding()) {
      res.status(409).json({ error: "a seed is already in progress" });
      return;
    }
    const overrides = parseSeedOverrides(req.body);
    if (typeof overrides === "string") {
      res.status(400).json({ error: overrides });
      return;
    }
    try {
      seeder.start(overrides);
    } catch (err) {
      if (err instanceof AlreadySeedingError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof SeedRefusedError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    res.status(202).json({ state: "seeding" });
  });

  app.post("/api/run", (req: Request, res: Response) => {
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== "v1" && mode !== "v2") {
      res.status(400).json({ error: "body must be { mode: 'v1' | 'v2' }" });
      return;
    }
    try {
      res.status(202).json(runner.start(mode));
    } catch (err) {
      if (err instanceof RunInProgressError || err instanceof FixtureNotReadyError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.post("/api/run/stop", (_req: Request, res: Response) => {
    void runner
      .stop()
      .then((result) => res.json(result))
      .catch((err: unknown) => {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
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

/** Optional `{ seedMode, seedKeys }` overriding the container's SEED_MODE / SEED_KEYS. A string is a 400. */
function parseSeedOverrides(body: unknown): SeedOverrides | string {
  const { seedMode, seedKeys } = (body ?? {}) as { seedMode?: unknown; seedKeys?: unknown };
  const overrides: SeedOverrides = {};
  if (seedMode !== undefined) {
    if (seedMode !== "bulk" && seedMode !== "lazy") return "seedMode must be 'bulk' or 'lazy'";
    overrides.seedMode = seedMode;
  }
  if (seedKeys !== undefined) {
    if (typeof seedKeys !== "number" || !Number.isInteger(seedKeys) || seedKeys < 1 || seedKeys > 1_000_000_000) {
      return "seedKeys must be an integer in 1..1000000000";
    }
    overrides.seedKeys = seedKeys;
  }
  return overrides;
}
