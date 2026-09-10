# Service contracts

Three Express services and one Redis, all on a single Docker network. Ports are host-mapped for
convenience; services address each other by container name.

| Service | Container | Host port | Redis access |
|---|---|---|---|
| benchmark | `benchmark` | 3000 | read/write (seeding) |
| test-api | `test-api` | 3001 | read only |
| webhook | `webhook` | 3002 | read + delete |
| redis | `redis` | 6379 | — |

> The original sketch said the webhook service needs *read* access. It needs to **delete**, which
> is the whole point of it. Read-only would make v2 a no-op.

## test-api

The innocent bystander. It must use its **own Redis connection**, so that when a scan blocks the
server this service is genuinely queued behind it rather than sharing a busy client.

### `GET /entitlement/:userId`

```jsonc
// 200
{
  "userId": "u_0001234",
  "hit": true,
  "variants": 2,
  "latencyMs": 0.41   // server-side, measured around the Redis call only
}
```

Reads via the index (`SMEMBERS` then `MGET`). Never scans. `hit: false` with `variants: 0` after
the user has been invalidated — that is the expected post-eviction state, not an error.

### `GET /health` → `{"ok":true}`

## webhook

### `POST /v1/invalidate` — legacy `KEYS` path
### `POST /v2/invalidate` — index path

```jsonc
// request
{ "userIds": ["u_0000001", "u_0000002"] }

// 202 — returns immediately; the work runs in the background
{ "jobId": "job_a1b2c3", "mode": "v1", "total": 1000 }
```

**Both endpoints return 202 immediately.** A 1,000-user v1 batch at ten million keys is roughly
three hours of blocked Redis; a synchronous response would hang the request and the demo. The
graph makes its point within seconds either way.

### `GET /jobs/:jobId`

```jsonc
{ "jobId":"job_a1b2c3", "mode":"v1", "state":"running",   // running | stopped | done | failed
  "total":1000, "processed":37, "removed":74, "startedAt":"…", "finishedAt":null,
  "incomplete":[] }
```

Jobs attempt all requested users unless stopped. `processed` counts attempted users, including
failures; `incomplete` lists `{entityId,error}` for each failed attempt. Completed jobs with any
failures have `state:"failed"` and an `error` summary. Other users still finish.
Retry only failed IDs by posting `{userIds: job.incomplete.map(entry => entry.entityId)}` to the
same invalidation endpoint after resolving the error. A stopped job also has unattempted users:
resume the original list from offset `processed` once the in-flight user has finished
(`finishedAt` is non-null).

### `POST /jobs/:jobId/stop` → `{ "jobId":"…", "state":"stopped" }`

Must abort between users, not mid-user. A stopped v2 job leaves no half-deleted entity: values
are deleted before references, so any interrupted user is simply re-invalidatable.

### `GET /health` → `{"ok":true}`

## benchmark

### `GET /` — the UI (see US-007)

### `GET /api/seed/status`

```jsonc
{ "state":"idle",           // idle | seeding | ready | failed
  "targetKeys":2000000, "users":1000000, "cacheKeys":2000000, "indexKeys":1000000,
  "progress":1.0, "seedValue":1, "memoryHuman":"712.40M" }
```

### `POST /api/seed` → 202. Idempotent: refuses with 409 while already seeding.
### `POST /api/seed/reset` → flushes and clears the marker.

### `POST /api/run`

```jsonc
{ "mode": "v1" }            // or "v2"
```

Starts a run: poll `test-api` once per second, and **one second after the first poll** send a
batch of `BATCH_USERS` (default 1000) user IDs to the matching webhook endpoint. Returns
`{ "runId":"…", "mode":"v1", "webhookJobId":"…" }`.

### `POST /api/run/stop`

Stops polling and calls `POST /jobs/:id/stop` on the webhook. Always available while a run is active.

### `WS /ws`

Server pushes one JSON frame per second:

```jsonc
{ "t":"sample", "runId":"…", "mode":"v1", "ts":1757400000000,
  "elapsedSec":12, "latencyMs":11040.2, "ok":true,
  "job": { "processed":1, "total":1000, "state":"running" } }
```

Plus lifecycle frames: `{"t":"run-started",…}`, `{"t":"run-stopped",…}`, `{"t":"seed-progress",…}`.

A client connecting mid-run receives a `{"t":"history","samples":[…]}` frame first so the chart
redraws correctly on refresh.
