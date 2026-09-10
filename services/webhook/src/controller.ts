// services/webhook — the two invalidation paths, side by side.
//
//   POST /v1/invalidate  legacy: one `KEYS *::<userId>::*` per user, then UNLINK the matches
//   POST /v2/invalidate  indexed: delegate to packages/cache `invalidateEntities`
//
// Identical inputs, identical fixture, one Redis. The only variable under test is *discovery* —
// which is why v1 deletes with UNLINK too, and why the v1 pattern keeps both `::` delimiters so it
// is a fair legacy implementation and not a broken one (see docs/REDIS-SCHEMA.md).
//
// Both endpoints return 202 immediately with {jobId,mode,total}; the work runs in the background
// and is observable through GET /jobs/:id. A 1,000-user v1 batch is not meant to finish.

import { EntityIndex, type RedisClient } from "@redis-hash-index/cache";
import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { BATCH_SIZE, CATEGORY, TENANT } from "./config";

const USER_ID_RE = /^u_\d{7}$/;

export enum JobMode {
  V1 = "v1",
  V2 = "v2",
};

export type JobState = "running" | "stopped" | "done" | "failed";

export interface Job {
  jobId: string;
  mode: JobMode;
  state: JobState;
  total: number;
  processed: number;
  removed: number;
  startedAt: string;
  finishedAt: string | null;
  error?: string;
}

/** The slice of a Redis client the legacy path touches directly. */
export interface WebhookRedis {
  keys(pattern: string): Promise<string[]>;
  unlink(...keys: string[]): Promise<number>;
}

export class WebhookController {
  private readonly index: EntityIndex;
  // Held per controller/app instance so job stores remain isolated.
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly redis: WebhookRedis) {
    this.index = new EntityIndex(redis as unknown as RedisClient, { categories: [CATEGORY] });
  }

  health = (_req: Request, res: Response): void => {
    res.json({ ok: true });
  };

  startJobV1 = (req: Request, res: Response): void => {
    const userIds = this.readUserIds(req, res);
    if (userIds === null) return;
    const job = this.createJob(JobMode.V1, userIds);
    // The background worker owns its error handling.
    void this.runJob(job, userIds);
    res.status(202).json({ jobId: job.jobId, mode: job.mode, total: job.total });
  };

  startJobV2 = (req: Request, res: Response): void => {
    const userIds = this.readUserIds(req, res);
    if (userIds === null) return;
    const job = this.createJob(JobMode.V2, userIds);
    // The background worker owns its error handling.
    void this.runJob(job, userIds);
    res.status(202).json({ jobId: job.jobId, mode: job.mode, total: job.total });
  };

  getJob = (req: Request, res: Response): void => {
    const job = this.lookup(req);
    if (job === undefined) {
      res.status(404).json({ error: "no such job" });
      return;
    }
    res.json(job);
  };

  stopJob = (req: Request, res: Response): void => {
    const job = this.lookup(req);
    if (job === undefined) {
      res.status(404).json({ error: "no such job" });
      return;
    }
    if (job.state === "running") job.state = "stopped";
    res.json({ jobId: job.jobId, state: job.state });
  };

  private readUserIds(req: Request, res: Response): string[] | null {
    const userIds = parseUserIds(req.body);
    if (userIds === null) {
      res.status(400).json({ error: "body must be { userIds: string[] } of ^u_\\d{7}$" });
    }
    return userIds;
  }

  private createJob(mode: JobMode, userIds: readonly string[]): Job {
    const job: Job = {
      jobId: `job_${randomBytes(4).toString("hex")}`,
      mode,
      state: "running",
      total: userIds.length,
      processed: 0,
      removed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.jobs.set(job.jobId, job);
    return job;
  }

  /**
   * Walk the user list one at a time. The stop flag is checked **between** users, never mid-user —
   * and because v2 deletes values before references, a user interrupted partway is simply
   * re-invalidatable, so there is no compensation logic here.
   */
  private async runJob(job: Job, userIds: readonly string[]): Promise<void> {
    try {
      for (const userId of userIds) {
        if (job.state === "stopped") break;
        const removed =
          job.mode === JobMode.V1
            ? await this.invalidateLegacy(userId)
            : (await this.index.invalidateEntities(TENANT, CATEGORY, [userId])).valuesUnlinked;
        job.processed += 1;
        job.removed += removed;
      }
      if (job.state === "running") job.state = "done";
    } catch (err) {
      job.state = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }

  private lookup(req: Request): Job | undefined {
    const id = req.params.jobId;
    return typeof id === "string" ? this.jobs.get(id) : undefined;
  }

  /**
   * The legacy path for one user: enumerate the whole keyspace for keys naming this user, then
   * UNLINK them in batches. The pattern must keep both `::` delimiters — `*<userId>*` would also
   * match `entityIndex::demo::activeSubscription::<userId>` (whose name ends at the id) and anything
   * with those characters in a `params` tail.
   */
  private async invalidateLegacy(userId: string): Promise<number> {
    const matches = await this.redis.keys(`*::${userId}::*`);
    let removed = 0;
    for (let i = 0; i < matches.length; i += BATCH_SIZE) {
      removed += await this.redis.unlink(...matches.slice(i, i + BATCH_SIZE));
    }
    return removed;
  }
}

function parseUserIds(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const { userIds } = body as { userIds?: unknown };
  if (!Array.isArray(userIds) || userIds.length === 0) return null;
  const out: string[] = [];
  for (const id of userIds) {
    if (typeof id !== "string" || !USER_ID_RE.test(id)) return null;
    out.push(id);
  }
  return out;
}
