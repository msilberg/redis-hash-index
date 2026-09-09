# services/

Three Express services, each its own npm workspace. They share `packages/cache` and nothing else —
in particular each opens its **own** ioredis connection (`new Redis(REDIS_URL)`), never a shared one.

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

## Tests

`node --import tsx --test "src/**/*.test.ts"`, `node:test` + `node:assert/strict`, real Redis on
DB 15 (`make test` brings up the `redis` container first). No mocks. Modules are `commonjs` — use
`__dirname`, not `import.meta.url`.

To test "stop between users" deterministically: start a job over a few thousand *unseeded* user
IDs (each user is one sequential `KEYS` round trip), POST the stop, then poll — it lands `stopped`
with `processed` well below `total` and touches no fixture data.
