// The run driver — the demo's stopwatch. A run polls test-api once per second with a seeded user
// id, waits one quiet second, then fires a batch of user ids at one of the two webhook endpoints
// and keeps streaming a `sample` frame per poll until stopped. See US-006.md and docs/API.md.
//
// Why the one-second baseline: without it the chart opens mid-catastrophe and there is nothing to
// compare the latency spike against.
//
// A poll that times out is data, not an error: a generous timeout, and on failure a `sample` with
// `ok:false` and the elapsed time — a gap in the chart during the worst moment would be the exact
// opposite of the point.

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

import { userIdFor } from "./fixture";

export type RunMode = "v1" | "v2";

/** The webhook job counters, as last read from `GET /jobs/:id`. */
export interface RunJobCounters {
  processed: number;
  total: number;
  removed: number;
  state: string;
}

export interface Sample {
  t: "sample";
  runId: string;
  mode: RunMode;
  ts: number;
  elapsedSec: number;
  /** HTTP round trip the driver measured, in ms. */
  latencyMs: number;
  /** What test-api reported for the Redis call alone, or null if the poll failed. */
  serverLatencyMs: number | null;
  ok: boolean;
  job: RunJobCounters | null;
}

export interface HistoryFrame {
  t: "history";
  runId: string;
  mode: RunMode;
  startedAt: number;
  batchAt: number | null;
  webhookJobId: string | null;
  samples: Sample[];
}

export interface StartResult {
  runId: string;
  mode: RunMode;
  webhookJobId: string | null;
}

export interface StopResult {
  stopped: boolean;
  runId?: string;
  webhookJobId?: string | null;
  webhookState?: string | null;
}

export interface RunnerConfig {
  testApiBaseUrl: string;
  webhookBaseUrl: string;
  pollIntervalMs: number;
  batchDelayMs: number;
  batchUsers: number;
  pollTimeoutMs: number;
  historyCap: number;
}

/** The slice of the seeder the run driver needs: is the fixture usable, and how many users. */
export interface RunnerSeeder {
  isReady(): boolean;
  readonly seededUserCount: number;
}

export class RunInProgressError extends Error {
  constructor() {
    super("a run is already in progress");
    this.name = "RunInProgressError";
  }
}

export class FixtureNotReadyError extends Error {
  constructor() {
    super("the fixture is not seeded");
    this.name = "FixtureNotReadyError";
  }
}

interface ActiveRun {
  runId: string;
  mode: RunMode;
  startedAt: number;
  userCount: number;
  /** The ids sent for eviction — polling switches to this pool once the batch is dispatched. */
  batchUserIds: string[] | null;
  batchAt: number | null;
  webhookJobId: string | null;
  lastJob: RunJobCounters | null;
}

/** Emits `frame` (a {@link Sample} or a lifecycle frame) for the WebSocket hub to broadcast. */
export class Runner extends EventEmitter {
  private active: ActiveRun | null = null;
  private samples: Sample[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly seeder: RunnerSeeder,
    private readonly config: RunnerConfig,
  ) {
    super();
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  /** Begin a run. Throws {@link RunInProgressError} / {@link FixtureNotReadyError}. */
  start(mode: RunMode): StartResult {
    if (this.active !== null) throw new RunInProgressError();
    const userCount = this.seeder.seededUserCount;
    if (!this.seeder.isReady() || userCount <= 0) throw new FixtureNotReadyError();

    const run: ActiveRun = {
      runId: `run_${randomBytes(4).toString("hex")}`,
      mode,
      startedAt: Date.now(),
      userCount,
      batchUserIds: null,
      batchAt: null,
      webhookJobId: null,
      lastJob: null,
    };
    this.active = run;
    this.samples = [];

    this.emit("frame", { t: "run-started", runId: run.runId, mode, ts: run.startedAt });

    // First poll now (t=0), then a self-scheduling loop so a slow poll never stacks up behind the
    // interval — during a v1 scan a poll can block for many seconds.
    void this.runPoll();
    this.batchTimer = setTimeout(() => {
      void this.dispatchBatch();
    }, this.config.batchDelayMs);
    this.batchTimer.unref();

    return { runId: run.runId, mode, webhookJobId: null };
  }

  /** Stop polling and tell the webhook to stop its job — otherwise a v1 job grinds on for hours. */
  async stop(): Promise<StopResult> {
    const run = this.active;
    if (run === null) return { stopped: false };
    this.active = null;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.batchTimer !== null) clearTimeout(this.batchTimer);
    this.pollTimer = null;
    this.batchTimer = null;

    let webhookState: string | null = null;
    if (run.webhookJobId !== null) {
      try {
        const res = await fetch(`${this.config.webhookBaseUrl}/jobs/${run.webhookJobId}/stop`, {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { state?: unknown };
          webhookState = typeof body.state === "string" ? body.state : null;
        }
      } catch {
        // best effort — the run is stopped on our side regardless
      }
    }

    this.emit("frame", {
      t: "run-stopped",
      runId: run.runId,
      mode: run.mode,
      ts: Date.now(),
      webhookJobId: run.webhookJobId,
      webhookState,
    });

    return {
      stopped: true,
      runId: run.runId,
      webhookJobId: run.webhookJobId,
      webhookState,
    };
  }

  /** The frame a client connecting mid-run receives first, so the chart redraws instead of blanking. */
  historyFrame(): HistoryFrame | null {
    const run = this.active;
    if (run === null) return null;
    return {
      t: "history",
      runId: run.runId,
      mode: run.mode,
      startedAt: run.startedAt,
      batchAt: run.batchAt,
      webhookJobId: run.webhookJobId,
      samples: [...this.samples],
    };
  }

  private async runPoll(): Promise<void> {
    const run = this.active;
    if (run === null) return;
    try {
      await this.poll(run);
    } catch {
      // poll owns its own errors; this guard is belt-and-braces so the loop never dies
    }
    if (this.active === run) {
      this.pollTimer = setTimeout(() => {
        void this.runPoll();
      }, this.config.pollIntervalMs);
      this.pollTimer.unref();
    }
  }

  private async poll(run: ActiveRun): Promise<void> {
    const userId =
      run.batchUserIds !== null
        ? (run.batchUserIds[Math.floor(Math.random() * run.batchUserIds.length)] as string)
        : userIdFor(Math.floor(Math.random() * run.userCount));

    const started = process.hrtime.bigint();
    let latencyMs: number;
    let ok = false;
    let serverLatencyMs: number | null = null;
    try {
      const res = await fetch(`${this.config.testApiBaseUrl}/entitlement/${userId}`, {
        signal: AbortSignal.timeout(this.config.pollTimeoutMs),
      });
      latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (res.ok) {
        const body = (await res.json()) as { latencyMs?: unknown };
        ok = true;
        serverLatencyMs = typeof body.latencyMs === "number" ? body.latencyMs : null;
      }
    } catch {
      latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    }

    const job = await this.readJob(run);

    if (this.active !== run) return; // stopped while this poll was in flight

    const now = Date.now();
    const sample: Sample = {
      t: "sample",
      runId: run.runId,
      mode: run.mode,
      ts: now,
      elapsedSec: Math.round((now - run.startedAt) / 1000),
      latencyMs,
      serverLatencyMs,
      ok,
      job,
    };
    this.samples.push(sample);
    if (this.samples.length > this.config.historyCap) this.samples.shift();
    this.emit("frame", sample);
  }

  private async readJob(run: ActiveRun): Promise<RunJobCounters | null> {
    if (run.webhookJobId === null) return null;
    try {
      const res = await fetch(`${this.config.webhookBaseUrl}/jobs/${run.webhookJobId}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const body = (await res.json()) as Partial<RunJobCounters>;
        const job: RunJobCounters = {
          processed: Number(body.processed ?? 0),
          total: Number(body.total ?? 0),
          removed: Number(body.removed ?? 0),
          state: typeof body.state === "string" ? body.state : "unknown",
        };
        run.lastJob = job;
        return job;
      }
    } catch {
      // a transient read failure shouldn't blank the counters mid-chart
    }
    return run.lastJob;
  }

  private async dispatchBatch(): Promise<void> {
    const run = this.active;
    if (run === null) return;

    const count = Math.min(this.config.batchUsers, run.userCount);
    const userIds = Array.from({ length: count }, (_, i) => userIdFor(i));
    run.batchUserIds = userIds;

    try {
      const res = await fetch(`${this.config.webhookBaseUrl}/${run.mode}/invalidate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userIds }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`webhook ${run.mode}/invalidate -> ${res.status}`);
      const body = (await res.json()) as { jobId?: unknown };
      if (typeof body.jobId !== "string") throw new Error("webhook response had no jobId");

      if (this.active !== run) return;
      run.webhookJobId = body.jobId;
      run.batchAt = Date.now();
      this.emit("frame", {
        t: "batch",
        runId: run.runId,
        mode: run.mode,
        webhookJobId: body.jobId,
        count,
        ts: run.batchAt,
        elapsedSec: Math.round((run.batchAt - run.startedAt) / 1000),
      });
    } catch (err) {
      if (this.active !== run) return;
      this.emit("frame", {
        t: "batch-error",
        runId: run.runId,
        mode: run.mode,
        ts: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
