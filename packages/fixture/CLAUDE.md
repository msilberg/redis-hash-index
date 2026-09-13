# packages/fixture

The deterministic fixture generator, the mock `BillingProvider` origin, and the `@Cache`-decorated
`SubscriptionService`. `benchmark` seeds from it; `benchmark` and `test-api` both fill through it.
One copy, so a record filled by either service is byte-identical to the bulk seed.

- **No `prepare` script, on purpose.** npm runs workspace `prepare` scripts in parallel, and this
  package compiles against `packages/cache`'s `dist/`. `make typecheck` / `make test` build cache
  then fixture (`make packages`); service Dockerfiles `RUN npm run build --workspace
  @redis-hash-index/fixture` after `npm ci`. A new consumer's Dockerfile needs that line too, plus
  `COPY packages/fixture` in the build stage and its `dist/` + `package.json` in the runtime stage.
- Changing `fixture.ts` or `schema.ts` changes every fixture. Keep benchmark's `seeder.test.ts`
  bulk-vs-lazy snapshot test green.
- Tests here are pure (no Redis).
