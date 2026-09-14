# services/

Four Express services, each its own npm workspace. They share `packages/*` and nothing else — never
import another service's workspace. Each Redis-using service opens its **own** ioredis connection
(`new Redis(REDIS_URL)`), never a shared one; `mock-billing` opens none.

Every Dockerfile's build stage copies EVERY workspace's `package.json` (`npm ci` checks the lockfile
against all of them). Adding a workspace means adding a `COPY <ws>/package.json` line to all of them.

## Consuming `packages/cache`

- Depend on it as `"@redis-hash-index/cache": "*"`.
- It has a `prepare` script (`tsc`), so `npm install` at the repo root builds its `dist/` and
  `make typecheck` / `make test` resolve its types with no manual build step.
- Pass your ioredis client where a narrow `RedisClient` / reader interface is expected and cast
  (`redis as unknown as ...`). Don't widen the interfaces in `packages/cache`.

## Dockerfile pattern (see services/test-api/Dockerfile)

- Build context is the **repo root** (`context: .` in docker-compose.yml) because of npm workspaces.
- Multi-stage: stage 1 copies the root manifests + every workspace `package.json` + this service's
  source, runs `npm ci` (which builds `packages/cache` via its `prepare`), `npm run build
  --workspace <svc>`, then `npm prune --omit=dev`. Stage 2 copies `node_modules`, the built
  `packages/cache/dist`, and this service's `dist`.
- Runtime is `node dist/index.js` — no `tsx` in production.
- Compose healthcheck: `node -e "fetch('http://127.0.0.1:<port>/health').then(...)"` (node:22 has
  global fetch; the image has no curl).

Endpoints that read a JSON request body need `app.use(express.json())` (webhook does; test-api
doesn't have a body). Fire long-running work with `void runJob(...)` and return `202` immediately —
never `await` it in the handler.

`test-api` must never enumerate the keyspace, so don't write `KEYS`/`scan(` even in its comments.
`webhook`'s v1 path *is* the legacy scan — `redis.keys('*::<userId>::*')` is deliberate there.

## benchmark

- It is not just an Express app: `src/index.ts` builds an `http.Server` so `ws` can attach at
  `/ws`. `createApp({ seeder, runner })` returns the app; `attachWebSocket(server, seeder, runner)`
  returns a hub whose `broadcast` fans out both the seeder's `progress` events and the runner's
  `frame` events. Tests drive both via `createServer(app)`.
- The `Runner` (`src/runner.ts`, US-006) is the run driver: it polls test-api and fires an
  eviction batch at the webhook over **HTTP by container name** (`TEST_API_URL` / `WEBHOOK_URL`),
  never sharing their Redis client. It self-schedules polls (`setTimeout` after each finishes), not
  `setInterval` — a v1 scan blocks a poll for many seconds and a fixed interval would stack them.
  `stop()` must also `POST /jobs/:id/stop` on the webhook or a v1 job grinds on for hours.
- `batch-completed` is emitted once per run from the job's `finishedAt`, never from the poll time.
  Stopping clears `active`, so no later poll sees the terminal state: `stop()` itself re-reads the job
  (bounded by `pollTimeoutMs`) and emits it before `run-stopped`. A stopped job has `finishedAt: null`
  until its in-flight user returns. The UI must match `batch-completed` by `runId` — it can arrive
  after the next run started.
- Test files run in parallel child processes: `seeder.test.ts` owns Redis DB 15, `runner.test.ts`
  owns DB 14. A new redis-touching test file needs its own DB number. (`ui.test.ts` is pure — no DB.)
- The UI (US-007) is `src/ui.ts` exporting `UI_HTML` as a string, not a static file: the Dockerfile
  copies only `dist/`, so a served string needs no extra copy step. It is one self-contained page —
  keep it CDN-free and framework-free (canvas chart in plain JS). The client reads `/ws` frames and
  polls `GET /api/seed/status` for seed `state` (the `seed-progress` frame carries only done/total).
- `Seeder(redis, index, filler, config)`: `filler` is a `LazyFiller` — in production `TestApiFiller`
  (`src/lazy-filler.ts`), which fills a record by `GET {TEST_API_URL}/subscription/:userId?v=n` and
  reads `GET {MOCK_BILLING_URL}/health` for the seed-value check. benchmark no longer calls
  `configureCache`. Tests inject an in-process `fakeChain` filler that `registerMany`s the generator's
  record; the real chain is tested in test-api's `chain.test.ts` and by `make verify`.
- `seeder.start()` is **async**: it claims `state = "seeding"` synchronously, then checks mock-billing's
  SEED_VALUE (only if a lazy request will happen) and rejects with `SeedRefusedError` → 400, restoring
  the previous state. Tests must `await` it and attach `once(seeder, "done")` BEFORE awaiting.
- The filler throws `OriginFailedError` for a test-api 502; the seeder tolerates only that class
  (skips the record, shrinks expected totals) and aborts on anything else.
- `fixture.recordsFor` / `recordOrdinalFor` are the per-user generator both the bulk writer and
  mock-billing use — plan IDs depend on record position.
- A `before`/`beforeEach` hook that `await once(seeder, "done")` hangs forever if the seed emits
  `failed` — race the two events and reject on `failed`.
- The seeder is deterministic from `SEED_VALUE`: `fixture.ts` generates byte-identical users,
  cache keys and values; `hashInt` is order-independent so `variantsFor(i)` never depends on
  iteration. Change the generator and every existing fixture / marker silently diverges.
- The seeder `flushdb()`s before writing, asserts `DBSIZE === cacheKeys + indexKeys` **before**
  writing `seed::marker`, so the live DBSIZE after a completed seed is that total **+ 1**.
- `seeder.init()` (called once at boot) loads the marker so status reports `ready` after a restart
  without reseeding. Nothing reseeds automatically.
- Compose passes `SEED_KEYS` / `SEED_VALUE` through from the shell env
  (`SEED_KEYS: "${SEED_KEYS:-2000000}"`), so `SEED_KEYS=50000 make up` works.
- Test gotcha: Node's global `fetch` (undici) keeps sockets alive, so `server.close()` hangs —
  call `server.closeAllConnections()` first. And a fast seed can emit `done` before an
  `once(seeder,"done")` listener attaches; poll `seeder.status()` instead of racing the event.

## test-api

- `createApp(redis, origin)`: one route, `/subscription/:userId`, in two modes. The default is the
  `@Cache` read-through. `?fill=false` is the SMEMBERS+MGET bystander the run driver and `make verify`
  poll (`readCachedVariants`, no decorator, no origin). The probe must NEVER fill: it would refill
  users a v1 run is evicting and make verify's "keys are gone" assertion meaningless.
  `read-path.test.ts` proves it writes nothing — keep that test mutation-sensitive (working origin).
- `origin` is a `SubscriptionOrigin` (`src/subscription-service.ts`): `BillingClient` in production
  (`src/billing-client.ts` — every non-2xx except 404, timeout, refusal and bad envelope is an
  `OriginError`; 404 is `null`), a stub in tests. `SubscriptionParams` is the key contract: the route
  copies `v` from the query and nothing else.
- The controller builds `new SubscriptionService(probe)` per request, the probe wrapping the shared
  origin — that is how a request learns `source`/`originMs`. The decorator's single-flight map is per
  decorated method, not per instance, so this does not defeat it.
- `app.test.ts` owns DB 15, `read-path.test.ts` DB 14, `chain.test.ts` DB 13; the last two call
  `configureCache` themselves. The interleaving test parks the origin on a latch
  (`GatedOrigin.hold()`) — order, not sleeps.
- `chain.test.ts` SPAWNS mock-billing (`node --import tsx ../mock-billing/src/index.ts`, `PORT=0`) and
  parses the port from its `listening on :N` log line. Change that line and the test cannot start.

## mock-billing

- The fake third party. Depends on `packages/fixture` only — no cache package, no ioredis. Its
  envelope (`src/envelope.ts`) is snake_case on purpose; test-api owns the mapping back.
- The self-check `grep -rn "ioredis\|redis" services/mock-billing/src` always matches the
  `@redis-hash-index/fixture` import lines (the package scope contains "redis"). Everything else must
  be clean — don't write "redis" in lowercase in its comments.
- Tests are pure HTTP on an ephemeral port; no database.

## Tests

`node --import tsx --test "src/**/*.test.ts"`, `node:test` + `node:assert/strict`, real Redis on
DB 15 (`make test` brings up the `redis` container first). No mocks. Modules are `commonjs` — use
`__dirname`, not `import.meta.url`.

To test "stop between users" deterministically: start a job over a few thousand *unseeded* user
IDs (each user is one sequential `KEYS` round trip), POST the stop, then poll — it lands `stopped`
with `processed` well below `total` and touches no fixture data.
