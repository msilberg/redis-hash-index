# Architecture

```
                    ┌──────────────┐
   browser ────────►│  benchmark   │ :3000   UI + WebSocket + seeder + load driver
                    └──────┬───────┘
                           │  1 req/sec              batch of user IDs
                    ┌──────▼───────┐            ┌──────────────┐
                    │   test-api   │ :3001      │   webhook    │ :3002
                    └──────┬───────┘            └──────┬───────┘
                           │ read                      │ delete
                           └─────────┬─────────────────┘
                                     ▼
                              ┌─────────────┐
                              │    redis    │ :6379   single instance, noeviction
                              └─────────────┘
```

## Why it is shaped like this

**Three separate containers, one Redis.** The demonstration is that an O(N) command on a shared
single-threaded server is not a slow function — it is an outage for everyone else on that server.
That only shows if the victim (`test-api`) is a genuinely separate process with its own connection
from the perpetrator (`webhook`). Collapse them into one service and the effect disappears into
the event loop.

**The benchmark service drives, it does not measure itself.** It polls `test-api` over HTTP once
a second and records the round trip. That includes HTTP overhead, which is honest: it is what a
real caller experiences. `test-api` also returns its own server-side Redis latency so the chart
can show both and the gap is visible.

**One second of quiet before the batch.** Every run polls for one second first, so the chart has a
baseline before the eviction starts. Without it the "before" is invisible.

## What each run should look like

**v1 (legacy).** Latency sits near 1 ms, then jumps to seconds the moment the first `KEYS` lands
and stays there, one step per scan. `processed` crawls. This is the graph that makes the point.

**v2 (index).** Latency stays flat and the batch of 1,000 finishes in well under a second. The
chart looks boring, which is the entire argument.

## Notes on honesty

The scanned keyspace includes the index keys, so v1 traverses slightly more than a cache with no
index would. That is a fair same-fixture comparison and it is stated in the README rather than
hidden.

The `latencyMs` figure is one sample per second from one client — enough to show a step change of
four orders of magnitude, not a rigorous latency distribution. The README says so.

## Registration and maintenance policy

The benchmark seeder is the demo's writer. It calls the shared package's
`registerMany([{ cacheKey, value, ttlSeconds }])`; `register()` delegates to the same implementation.
Each bounded transaction (at most 500 records by default) queues `SET EX`, `SADD`,
`EXPIRE NX`, and `EXPIRE GT`. ioredis pipelines the transaction, so seeding does not require a
round trip per record. The seeder buffers about 20,000 commands' worth of records at a time and
counts progress only after registration succeeds.

Including the value closes the gap where another client could invalidate between the cache write
and registration. Registration without a value only updates the index: a separate caller's earlier
`SET` is not made atomic retroactively. Redis transactions prevent interleaving but do not roll
back runtime command errors. Every reply is checked; any error fails the seed and prevents its
completion marker. Reseeding rebuilds the fixture from scratch.
See [Redis transaction semantics](https://redis.io/docs/latest/develop/using-commands/transactions/).

**Pruning is provided but is not scheduled in this demo.** Each fixture has only 1–3 variants per
entity, a 3600-second TTL on both values and sets, and no ongoing writer extending those sets.
Stale references left by v1 disappear when the index expires. An application with ongoing writes
should call `prune(tenant, category, entityId)` on its known entities during a bounded maintenance
sweep outside benchmark runs; this demo does not add background Redis traffic to the comparison.

Prune iterates with `SSCAN COUNT batchSize`, checking values and removing missing references in
batches per page. COUNT is a hint; duplicate observations and empty nonterminal pages are possible,
so `membersChecked` counts observations, not distinct members. No full-set accumulator is kept.
Like any scan, it is not a snapshot. Concurrent same-key rewrites can race the EXISTS/SREM check;
coordinate maintenance with such writers or prune during a quiet period.
See [Redis scan guarantees](https://redis.io/docs/latest/commands/scan/).

## Invalidation progress and retries

The webhook deliberately passes one entity at a time to v2: progress and Stop remain exact between
users. The package's configurable concurrency is available to batch callers and tested with
multiple entities, but is not a claimed webhook throughput optimization.

`invalidateEntities()` finishes healthy entities and returns `incomplete: [{ entityId, error }]`
for failures. Its `entities` counter counts successes; the other counters include acknowledged
commands from partially completed entities. Invalid coordinates still reject before Redis I/O.
A lost reply can leave a counter below the actual work Redis performed; retries remain safe.

Both webhook modes continue past entity failures. Jobs expose `incomplete`, count attempted users
in `processed`, and finish as `failed` if any attempt failed. A stopped job stays `stopped` and
retains failures already observed. Submit `incomplete.map(entry => entry.entityId)` as `userIds`
to retry failures after resolving their cause. For stopped jobs, also resume the unattempted
suffix of the original list starting at `processed`.

## The read path

Everything above treats the cache as already full. `GET /subscription/:userId` on test-api fills
it: a read-through in front of a fake billing origin, built from `packages/cache`'s `readThrough()`
and its standard (TC39) method decorator, `@Cached`.

```ts
@Cached({ category: CATEGORY, ttlSeconds: 3600, cacheNegative: true, negativeTtlSeconds: 60 })
async getActiveSubscription(userId: string, params: SubscriptionParams) {
  return await this.origin.getActiveSubscription(userId, params);
}
```

**What the decorator hides.** The call site never mentions Redis. The key is
`<service>::<tenant>::<category>::<entityId>::<params>`, and the params tail is a sorted-key
JSON serialisation of the method's arguments. The framework builds it in one line, and nobody reads it.
That is why the key is easy to build and hard to delete from: one day someone passes you a user ID
and says "invalidate this". The params that produced each key are gone, so you cannot rebuild the
names. You can only enumerate the keyspace (v1) or ask an index that recorded them (v2). The read
path writes through `registerMany`, so every value it creates is recorded in the same transaction
as its `SET EX`.

**Errors are not answers.** A loader that throws propagates; nothing is written. A loader that
resolves `null` is an authoritative "no", cached only under an explicit `cacheNegative` with its own
TTL. A `catch` that returns `undefined` would merge these two cases into one and turn a transient
provider blip into a cached "no subscription" for the whole TTL. `readThrough` rejects `undefined`
for that reason. Concurrent misses for one key in one process share a single origin call
(single-flight), so a warm-up loop against a slow origin cannot become a thundering herd.

**What the interleaving test demonstrates — bounded staleness, not atomicity.**
`packages/cache/src/read-through.test.ts` runs against real Redis and asserts the documented outcome
of the race. It does not claim to fix it:

- *Invalidation lands mid-fill.* A fill starts against an origin held open. The invalidation runs
  and removes the value and reference that existed at that moment. The origin then answers with
  what it read *before* the invalidation, and the fill writes it. The test asserts that the value and its
  index reference agree (no orphan value, no dangling reference; `registerMany` buys that). It also
  asserts that the stale value is still served from cache after the invalidation, and that it and
  its reference are gone once the TTL has passed.
- *Invalidation lands after the fill.* Value and reference are both gone; the next read reaches
  the origin.
- *Origin error.* The call rejects, no key and no index member exist, and the next call reaches
  the origin again.
- *Single-flight.* Fifty concurrent misses produce one loader call and one write.
- *Key round-trip.* A key built by the wrapper parses back to the same coordinates.

So an invalidation cannot stop a fill that began before it. A fill that read the origin before the
change can still write afterwards, and that stale value lives until its TTL expires. The index keeps
that value deletable by the *next* invalidation; it does not prevent the write. Closing the race needs
a per-entity generation number: bump it on invalidation, and have the fill write only if the
generation it read at the start is still current, checked in the same transaction. This demo
deliberately does not do that. The TTL is the bound.

The origin is fake and deterministic from `SEED_VALUE`: `ORIGIN_LATENCY_MS` (default 150) delays every
answer, one user in eight has no subscription, and `ORIGIN_FAIL_USER` always throws. The seeder
does not use the read path; it writes the fixture directly with `registerMany`. The benchmark polls
`GET /entitlement/:userId`, which never calls the origin, so a run's graph is unaffected.
