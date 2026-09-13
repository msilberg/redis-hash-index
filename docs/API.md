# Service contracts

Four Express services and one Redis, all on a single Docker network. Ports are host-mapped for
convenience; services address each other by container name.

| Service | Container | Host port | Redis access |
|---|---|---|---|
| benchmark | `benchmark` | 3000 | read/write (bulk seeding only) |
| test-api | `test-api` | 3001 | read; fills through `@Cache` on `/subscription` |
| webhook | `webhook` | 3002 | read + delete |
| mock-billing | `mock-billing` | 3003 | **none** — the fake third party |
| redis | `redis` | 6379 | — |

The fill chain: `benchmark --GET /subscription--> test-api --GET /subscription--> mock-billing`.

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

### `GET /subscription/:userId?v=1` — the read path

A read-through fill in front of `mock-billing`. The route calls the `@Cache`-decorated
`SubscriptionService.getActiveSubscription(userId, params)`; the decorator reads the cache, calls
`mock-billing` only on a miss, and writes value and index reference in one `MULTI`. The route never
builds a key.

```jsonc
// 200
{
  "userId": "u_0000001",
  "source": "origin",        // "cache" | "origin" — whether THIS request called the origin
  "variants": 2,             // live cached variants for the user after the read (SMEMBERS + MGET)
  "latencyMs": 4.76,         // Redis only: the decorated call minus origin time, plus the variant read
  "originMs": 3.12,          // present only when source is "origin" — includes the HTTP hop
  "subscription": { "userId":"u_0000001", "planId":"team-monthly", "status":"active",
                    "renewsAt":"2026-11-15", "seats":2 }   // null if the user has no such variant
}
// 400 — userId not ^u_\d{7}$, or v not a positive integer
// 502 { "error": "…" } — the origin failed; nothing was cached
```

**Only `v` reaches the key.** `SubscriptionParams` is built field by field from the query string:
`?v=2` is `getActiveSubscription(userId, { v: 2 })` and the key's `params` segment is `{"v":2}`,
byte-identical to the bulk seeder's. Every other query parameter (`include_addons`, tracking
parameters, typos) is dropped, because a stray one would be a different key: a permanent miss and a
record an invalidation never finds. No `v` is `{}`, a separate key that `mock-billing` answers with
variant 1.

**How `mock-billing`'s answers map** (`src/billing-client.ts`):

| `mock-billing` | test-api | cached? |
|---|---|---|
| 200 envelope | 200, the mapped `subscription` | yes |
| 404 | 200, `subscription: null` | no (`cacheNegative` is off) |
| 503, any other non-2xx | 502 | no |
| timeout (`BILLING_TIMEOUT_MS`, default 5000), connection refused, unparseable or unexpected envelope | 502 | no |

**A 502 writes nothing to Redis** — no value and no index member — and the next call reaches the
origin again. The mapper normalises through `packages/fixture`'s `serializeSubscription`, so a
filled value is byte-identical to the bulk-seeded one.

A request that joins another request's in-flight fill for the same key (single-flight) does not call
the origin itself and reports `source: "cache"`, although its `latencyMs` includes that wait.

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

## mock-billing

The fake billing provider ("Chargebee"). It never opens a Redis connection and does not depend on
the cache package. Every answer derives from `packages/fixture`'s generator, so the same `userId`,
`SEED_VALUE` and variant always produce the same envelope, in every container. Exactly two routes.

Environment: `PORT` (3003), `SEED_VALUE`, `ORIGIN_LATENCY_MS` (an awaited delay before every
`/subscription` answer, default 0), `ORIGIN_FAIL_USER` (always 503).

### `GET /health` → `{ "ok": true, "seedValue": 1 }`

The benchmark seeder reads `seedValue` before its first lazy request and refuses the seed if it
differs from its own.

### `GET /subscription/:userId?v=1&include_addons=true`

`v` is the variant (default 1). `include_addons` is accepted for realism and changes nothing.

```jsonc
// 200 — snake_case, shaped like a real provider's API, not like our internal record
{
  "subscription": {
    "id": "sub_u_0000001_1",
    "customer_id": "cus_u_0000001",
    "plan_id": "pro-monthly",
    "status": "active",
    "current_term_end": 1793923200,   // unix seconds: midnight UTC of the record's renewsAt
    "seats": 3,
    "object": "subscription"
  },
  "customer": { "id": "cus_u_0000001", "object": "customer" }
}
// 400 { "error" } — userId not ^u_\d{7}$, or v not a positive integer
// 404 { "error" } — the user has no such variant
// 503 { "error" } — the user is ORIGIN_FAIL_USER
```

## benchmark

### `GET /` — the UI (see US-007)

### `GET /api/seed/status`

```jsonc
{ "state":"idle",           // idle | seeding | ready | failed
  "targetKeys":2000000, "users":1000000, "cacheKeys":2000000, "indexKeys":1000000,
  "progress":1.0, "seedValue":1, "memoryHuman":"712.40M" }
```

### `POST /api/seed` → 202. Idempotent: refuses with 409 while already seeding.

Optional body `{ "seedMode": "bulk" | "lazy", "seedKeys": 50000 }` overrides the container's
`SEED_MODE` / `SEED_KEYS` for this one seed. The seeder returns 400 without touching Redis for a
malformed override or for `lazy` above `LAZY_MAX_KEYS`. The error message names the flag.

Lazy fills (`seedMode: "lazy"` and the `lazy-warm` phase) call `GET {TEST_API_URL}/subscription/:userId?v=n`
once per record, `LAZY_CONCURRENCY` at a time. Before the first one, the seeder reads
`GET {MOCK_BILLING_URL}/health`. If `mock-billing` is unreachable or its `seedValue` differs, the
seed is refused with 400 before Redis is touched, and the message names both values.

Status also carries `seedMode`, `phase` (`bulk` | `lazy` | `lazy-warm`, the phase running or last
run) and `originFailures`: records `test-api` answered 502 for during a lazy fill, none of them
cached. `cacheKeys`/`indexKeys` then count what was actually written. `seed-progress` frames
include `phase`.
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
