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

## Tests

Real Redis only (no mocks) — NX/GT expiry, MULTI-without-rollback and the SREM-vs-concurrent-writer
cases don't reproduce otherwise. `make test` runs `docker compose up -d redis` first; tests use DB
15 and `flushdb` between cases. Override the target with `REDIS_URL`.
