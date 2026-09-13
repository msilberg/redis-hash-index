# packages/fixture

The deterministic fixture generator, and only the generator: `prng.ts`, `fixture.ts`, `schema.ts` and
the barrel. `benchmark` bulk-seeds from it and `mock-billing` answers from it, so a record filled
through the chain (benchmark → test-api → mock-billing) is byte-identical to the bulk seed.

- **It depends on no other workspace.** No cache package, no Redis, no HTTP. The index key format is
  injected into `generateUsers` by the caller. Keep it that way: `mock-billing` imports this package
  and must never pull a cache client in transitively.
- `serializeSubscription()` is the ONLY way a `Subscription` becomes a string. The bulk writer stores
  it; test-api's envelope mapper normalises through it. Never `JSON.stringify` a subscription built
  somewhere else — key order decides byte-identity.
- **No `prepare` script.** `make typecheck` / `make test` build cache then fixture (`make packages`);
  service Dockerfiles `RUN npm run build --workspace @redis-hash-index/fixture` after `npm ci`. A new
  consumer's Dockerfile needs that line too, plus `COPY packages/fixture` in the build stage and its
  `dist/` + `package.json` in the runtime stage.
- `tsc` does not delete stale output. After moving or deleting a file here, `rm -rf dist` before
  building, or a consumer can still resolve the removed module from `dist/`.
- Changing `fixture.ts` or `schema.ts` changes every fixture. Keep test-api's `chain.test.ts`
  (bulk value vs a refill through mock-billing) green.
- Tests here are pure (no Redis).
