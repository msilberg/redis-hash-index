# Architecture

```
                     ┌──────────────┐
   browser ─────────►│  benchmark   │ :3000   UI + WebSocket + seeder + run driver
                     └───┬──────┬───┘         (the bulk seed writes Redis directly)
     1 poll/sec and      │      │  batch of user IDs
     the lazy fills      │      └───────────────────┐
                     ┌───▼──────────┐        ┌──────▼───────┐
                     │   test-api   │ :3001  │   webhook    │ :3002
                     └───┬──────┬───┘        └──────┬───────┘
                         │      │ HTTP, on a miss   │
                         │  ┌───▼──────────┐        │
                         │  │ mock-billing │ :3003  │   the fake billing provider, no Redis
                         │  └──────────────┘        │
                         │ read · fill              │ delete
                         └────────────┬─────────────┘
                                      ▼
                               ┌─────────────┐
                               │    redis    │ :6379   single instance, noeviction
                               └─────────────┘
```

A lazy fill is two hops, each across a real process boundary:

```
benchmark (seed)  --HTTP-->  test-api  --HTTP-->  mock-billing
                              │
                              └── @Cache(ENTITY_INDEX_CACHE) writes Redis on the miss
```

## Why it is shaped like this

**Separate containers, one Redis.** The demonstration is that an O(N) command on a shared
single-threaded server is not a slow function — it is an outage for everyone else on that server.
That only shows if the victim (`test-api`) is a genuinely separate process with its own connection
from the perpetrator (`webhook`). Collapse them into one service and the effect disappears into
the event loop.

**The benchmark service drives, it does not measure itself.** It polls `test-api` over HTTP once
a second (`GET /subscription/:userId?fill=false`, a cache read that never fills — a filling poll
would refill the users a run is evicting) and records the round trip. That includes HTTP overhead, which is honest: it is what a
real caller experiences. `test-api` also returns its own server-side Redis latency so the chart
can show both and the gap is visible.

**`test-api` is the only writer of cache keys through `@Cache`.** Every lazily filled record is
written by the service named in the key's `service` segment (`test-api`). The benchmark reaches it
over HTTP like any other client; only its bulk writer still talks to Redis directly, through the
shared `registerMany`, because 2,000,000 records cannot arrive one HTTP request at a time.

**The third party is a service, not a class.** `mock-billing` stands in for a billing provider. It
sits behind a network hop with a timeout (`BILLING_TIMEOUT_MS`), it can be slow
(`ORIGIN_LATENCY_MS`) or fail (`ORIGIN_FAIL_USER`, a 503), and it speaks its own snake_case schema,
which `test-api`'s `billing-client.ts` maps back to the internal record. It never touches Redis and
does not depend on `packages/cache`.

**Why `packages/fixture` stays shared.** It holds only the generator (`prng`, `fixture`, `schema`):
the single definition of which record a `(userId, variant, SEED_VALUE)` triple denotes. The bulk
seeder and `mock-billing` both depend on it. Two copies of the generation rules would let the bulk
and lazy paths disagree without anything failing, and "the same records, written two ways" would
stop being true. For the same reason it exports one `serializeSubscription()`: the bulk writer
stores it, and `test-api`'s mapper normalises through it, so JSON key order cannot split the bytes.
Because three containers share `SEED_VALUE`, the seeder reads `mock-billing`'s `/health` before its
first lazy request and refuses the seed, naming both values, if they differ.

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
getActiveSubscription(userId: string, params: SubscriptionParams = {}) { … }
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

**Where the demo uses it.** `SubscriptionService` (in `services/test-api`) decorates a call to its
`SubscriptionOrigin`: in production the S2S `BillingClient` in front of `mock-billing`, in tests a
stub injected through the constructor. For a given user and variant, `mock-billing` answers with
exactly the record the fixture generator writes. The fixture can be filled two ways:

- `SEED_MODE=bulk` (the default) pipelines ~20k commands per round trip. This is the only way
  2,000,000 records land in about a minute.
- `SEED_MODE=lazy` sends every record through the chain: one HTTP request to `test-api`, then one
  `GET`, one call to `mock-billing` and one `MULTI` each. It refuses to run above `LAZY_MAX_KEYS`.

In both modes, the first `LAZY_WARM_USERS` users are filled through the chain in a last
`lazy-warm` phase. Those users are the eviction batch, so the default run evicts records written
by `@Cache`. The two modes produce the same `DBSIZE` and byte-identical values for a given
`SEED_VALUE`. `services/test-api/src/chain.test.ts` asserts it across a real `mock-billing` process
(bulk-write a user, invalidate it, refill it through the route, compare byte for byte), and
`make verify` repeats that check against the running stack.

## Read path

`test-api`'s `GET /subscription/:userId` is the demo's cache *fill*, and the lazy seeder's too. It
calls the decorated `SubscriptionService`, whose origin is `mock-billing` over HTTP:

```ts
class SubscriptionService {
  @Cache(CacheKey.ACTIVE_SUBSCRIPTION, TTL.MEDIUM, CacheStrategy.ENTITY_INDEX_CACHE)
  getActiveSubscription(userId: string, params: SubscriptionParams = {}) {
    return this.billing.getActiveSubscription(userId, params);
  }
}
```

The route builds `SubscriptionParams` field by field — today only `v` — and drops every other query
parameter. The raw query object never reaches the decorator: `?v=2&include_addons=true` must produce
the bulk seeder's `{"v":2}` key, or the fill is a permanent miss that an invalidation also never finds.

`BillingClient` turns the remote system's failure modes into what the cache understands. A 2xx
envelope becomes a `Subscription`. A 404 becomes `null`, an authoritative "no such subscription"
that is not cached either, because `cacheNegative` stays off. Every other status, a timeout, a refused
connection and an envelope it cannot map becomes an `OriginError`: never cached, and the route
answers 502.

**What the decorator hides.** The call site names no key and touches no Redis. The key —
`test-api::demo::activeSubscription::u_0000001::{"v":2}` — is built from the arguments, and the
`params` tail grows a new variant for every new combination of call options.
Nobody writes that key down, so it is trivially easy to *create*. It is hard to *delete from*: the
day someone hands you one user ID and says "invalidate this", the variants that exist are whatever
the callers happened to pass. A pattern scan finds them at O(keyspace); the index finds them because
every fill registered its key in the same `MULTI` that wrote the value.

**The race it cannot close.** A fill reads the origin, then writes. An invalidation that lands in
between deletes everything the index lists *at that moment* — and the fill, holding an origin answer
from before the invalidation, writes it afterwards. The integration test
`services/test-api/src/read-path.test.ts` reproduces that interleaving deterministically (the origin
call is parked on a latch while the invalidation runs) and asserts:

- the invalidation removed the values and references that existed when it ran;
- the late fill then lands **both** its value and its index reference — the only keys left are that
  value and its set, and the set names exactly that value (no orphan value, no dangling reference);
- that value is armed with the full TTL, the reference's TTL is at least as long, and it is served
  from the cache without another origin call — it survives until its TTL expires or the next
  invalidation, which the test shows still finds and removes it through the index.

A second test asserts that an invalidation after a *completed* fill removes value and reference, and
the next read goes back to the origin. A third asserts that an origin error returns 502, writes no
key and no index member, and that the next call still reaches the origin.

**What that demonstrates is bounded staleness, not atomicity.** The value the late fill wrote may be
older than the invalidation; the demo promises only that it is reachable through the index and gone
by its TTL. The test does not wait out the hour — it asserts the TTL is armed and bounded. Closing
the race properly needs generation numbers (an invalidation bumps a per-entity generation, and a fill
that read under an older one refuses to write). This demo deliberately does not implement them.

## Registration and maintenance policy

The benchmark's bulk seeder is the demo's high-volume writer. It calls the shared package's
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
