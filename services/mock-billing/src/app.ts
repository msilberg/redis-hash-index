// services/mock-billing — the "Chargebee". A real service behind a network hop, so the cache in
// test-api sits in front of something that can be slow (ORIGIN_LATENCY_MS), fail (ORIGIN_FAIL_USER)
// and speak someone else's schema. Exactly two routes. See docs/API.md.

import express, { type Express, type Request, type Response } from "express";

import { toEnvelope } from "./envelope";
import { ProviderUnavailableError, type BillingProvider } from "./provider";

const USER_ID_RE = /^u_\d{7}$/;
const VARIANT_RE = /^[1-9]\d{0,2}$/;

export function createApp(provider: BillingProvider): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, seedValue: provider.seedValue });
  });

  // `?include_addons=true` is accepted for realism and changes nothing: the fixture has no add-ons.
  app.get("/subscription/:userId", (req: Request, res: Response) => {
    const userId = req.params.userId;
    if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
      res.status(400).json({ error: "userId must match ^u_\\d{7}$" });
      return;
    }
    const { v } = req.query;
    if (v !== undefined && (typeof v !== "string" || !VARIANT_RE.test(v))) {
      res.status(400).json({ error: "v must be a positive integer" });
      return;
    }
    const variant = v === undefined ? 1 : Number(v);

    provider
      .getActiveSubscription(userId, variant)
      .then((subscription) => {
        if (subscription === null) {
          res.status(404).json({ error: `no subscription variant ${variant} for ${userId}` });
          return;
        }
        res.json(toEnvelope(subscription, variant));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        res.status(err instanceof ProviderUnavailableError ? 503 : 500).json({ error: message });
      });
  });

  return app;
}
