# packages/cache

The shared cache strategies and the `@Cache` decorator. `test-api` reads through the entity index,
`webhook` invalidates through it, `benchmark` fills through the decorator. Never re-implement key
building or invalidation elsewhere.

## Layout

- `src/index.ts` is a barrel only. `src/redis.ts` = the narrow client interfaces; `src/keys.ts` =
  segment/TTL validation + `chunk` (shared, import from here — not from a strategy);
  `src/strategies/default.ts` → `strategies/entity-index.ts` (subclass); `src/cache-decorator.ts`.
- Adding a Redis command to any strategy means adding it to `RedisClient` AND to the hand-built
  stub clients in `index.test.ts` (they are typed `RedisClient`, so typecheck catches it).
- `EntityIndexCacheStrategy.set` on an owned key must stay one `registerMany` MULTI — never
  `super.set()` + register (reopens the write/registration race).
- `@Cache` is a standard TS 5 decorator (esbuild/tsx and tsc both lower it). It resolves strategies
  from a module-level registry at CALL time: every process (service bootstrap, each test file) must
  call `configureCache(...)` first. `resetCacheConfiguration()` exists for tests.
- The decorator's key is `service::tenant::category::<arg0>::<canonical JSON of arg1 or {}>`. For
  the fixture's `{"v":N}` keys, call with `(userId, { v: N })`.

## Conventions

- Consumers pass their ioredis client where a `RedisClient` is expected. ioredis's `Redis` is
  structurally wider than `RedisClient`; cast at the call site (`redis as unknown as RedisClient`)
  rather than widening the interface here. The narrow interface is deliberate — it lists every
  Redis command this package can touch.
- `parse` returns `null` for anything that isn't a cache key for a configured category; it never
  throws. `indexKeyFor` / `register` throw on a bad segment or unknown category.
- TTLs are validated (`1..2592000`, whole seconds) before any write. A rejected call writes nothing.

## Building

`prepare` runs `tsc` on `npm install`, so a fresh `npm install` at the repo root leaves `dist/`
in place and service workspaces can typecheck/test against `dist/index.d.ts` with no extra step.
Keep `main`/`types` pointed at `dist/` — services `require()` the compiled JS at runtime.

## Tests

Real Redis only (no mocks) — NX/GT expiry, MULTI-without-rollback and the SREM-vs-concurrent-writer
cases don't reproduce otherwise. `make test` runs `docker compose up -d redis` first;
`index.test.ts` uses DB 15, `cache-decorator.test.ts` DB 14 (files run in parallel), both `flushdb`
between cases. Override the target with `REDIS_URL`.
