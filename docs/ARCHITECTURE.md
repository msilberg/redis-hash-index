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

## Cache strategies

Services cache a method by annotating it. They never build a key:

```ts
@Cache(CacheKey.ACTIVE_SUBSCRIPTION, TTL.MEDIUM, CacheStrategy.ENTITY_INDEX_CACHE)
async getActiveSubscription(userId: string, params: SubscriptionParams = {}) { … }
```

The decorator builds `service::tenant::<CacheKey>::<first argument>::<canonical JSON of the rest>`.
It sorts keys at every depth, so argument key order never splits one record into two. It reads
through the strategy and calls the method only on a miss, then writes the result back through the
strategy. Concurrent misses for the same key in one process share a single call. A rejection is
never cached, and neither is `undefined`. `null` is cached only with `{ cacheNegative: true }`.
Otherwise a five-second provider outage becomes an hour of cached "no subscription".

`packages/cache` provides two strategies:

- **`DefaultCacheStrategy`** owns the Redis client (`protected readonly`) and implements `get`
  (`GET`) and `set` (`SET EX`, TTL validated before any command). It knows nothing about
  indexes. Because the client lives in the base class, a subclass shares that connection instead of
  opening a second one.
- **`EntityIndexCacheStrategy extends DefaultCacheStrategy`** adds the entity index (`indexKeyFor`,
  `parse`, `registerMany`, `invalidateEntities`, `prune`) and overrides `set`. A key in a category it
  does not own goes to `super.set()`. A key it owns goes to
  `registerMany([{ cacheKey, value, ttlSeconds }])`.

That override *means* "write the value, then register it". It is not written as
`super.set(); register();`, because that would take two round trips. An invalidation landing between
them would miss the value, which would then survive to its TTL with no reference. `registerMany`
queues `SET EX`, `SADD`, `EXPIRE NX` and `EXPIRE GT` in one `MULTI`, so a value never exists
without its reference.

Decorators are evaluated when the class is defined, before any connection exists. Each service
calls `configureCache({ redis, service, tenant, categories })` once at bootstrap, and a decorated
method looks up its strategy when it is called. Calling one before configuration throws; the
cache is never silently bypassed. These are standard TypeScript 5 decorators: no
`experimentalDecorators`, no `reflect-metadata`.

**Where the demo uses it.** The benchmark's `SubscriptionService` decorates a call to a
deterministic mock `BillingProvider`. For a given user and variant, the provider returns exactly
the record the fixture generator writes, and it never touches Redis. The fixture can be filled two
ways:

- `SEED_MODE=bulk` (the default) pipelines ~20k commands per round trip. This is the only way
  2,000,000 records land in about a minute.
- `SEED_MODE=lazy` sends every record through the decorator: one `GET`, one origin call and one
  `MULTI` each. It refuses to run above `LAZY_MAX_KEYS`.

In both modes, the first `LAZY_WARM_USERS` users are filled through the decorator in a last
`lazy-warm` phase. Those users are the eviction batch, so the default run evicts records written
by `@Cache`. The two modes produce the same `DBSIZE` and byte-identical values for a given
`SEED_VALUE`, and a test asserts it.

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
