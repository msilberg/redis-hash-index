# packages/cache

The shared entity index. `test-api` reads through it, `webhook` invalidates through it. One module,
imported twice — never re-implement key building or invalidation elsewhere.

## Conventions

- Consumers pass their ioredis client where a `RedisClient` is expected. ioredis's `Redis` is
  structurally wider than `RedisClient`; cast at the call site (`redis as unknown as RedisClient`)
  rather than widening the interface here. The narrow interface is deliberate — it lists every
  Redis command this package can touch.
- `parse` returns `null` for anything that isn't a cache key for a configured category; it never
  throws. `indexKeyFor` / `register` throw on a bad segment or unknown category.
- TTLs are validated (`1..2592000`, whole seconds) before any write. A rejected call writes nothing.
- `read-through.ts` (re-exported from `index.ts`) is the read path: `readThrough()` + the `@Cached`
  **standard** decorator. Never enable `experimentalDecorators` or add `reflect-metadata` — tsc
  (build) and tsx/esbuild (tests) both handle TC39 decorators with the shared tsconfig as is.
  Keys are built by `ReadThroughCache.keyFor` and checked by parsing them back; don't concatenate
  keys by hand. A loader that throws writes nothing; `null` is the only "negative" value.
- A decorated method still resolves the plain value. Callers that need `source`/timings wrap the
  call in `captureReads()` (AsyncLocalStorage, so concurrent requests don't mix).
- `CacheParams` is `object`, not `Record<string, unknown>`: TS interfaces have no index signature
  and would fail decorator signature inference.

## Building

`prepare` runs `tsc` on `npm install`, so a fresh `npm install` at the repo root leaves `dist/`
in place and service workspaces can typecheck/test against `dist/index.d.ts` with no extra step.
Keep `main`/`types` pointed at `dist/` — services `require()` the compiled JS at runtime.

## Tests

Real Redis only (no mocks) — NX/GT expiry, MULTI-without-rollback and the SREM-vs-concurrent-writer
cases don't reproduce otherwise. `make test` runs `docker compose up -d redis` first; `index.test.ts` uses DB
15 and `read-through.test.ts` uses DB 14 (test files run in parallel processes), each `flushdb`
between cases. Override the target with `REDIS_URL`.
