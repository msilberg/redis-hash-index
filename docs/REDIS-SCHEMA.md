# Redis schema — the contract every service shares

Any service that reads or writes the cache MUST follow this exactly. Getting a delimiter or a
pattern wrong here is the difference between a demo that proves a point and one that lies.

## Cache records (Redis strings)

```
KEY    test-api::demo::activeSubscription::u_0001234::{"v":1}
VALUE  {"userId":"u_0001234","planId":"pro-monthly","status":"active","renewsAt":"2026-11-01","seats":3}
TTL    3600 seconds
```

Key grammar — five `::`-separated segments, no exceptions:

```
<service>::<tenant>::<category>::<entityId>::<params>
```

| Segment | Value in this demo | Notes |
|---|---|---|
| `service` | `test-api` | who wrote the record |
| `tenant` | `demo` | single tenant throughout |
| `category` | `activeSubscription` | the only indexed category here |
| `entityId` | `u_` + 7 zero-padded digits | e.g. `u_0000042` |
| `params` | `{"v":1}` … `{"v":3}` | the variant. Opaque: never parsed |

Every segment except `params` matches `[A-Za-z0-9_.-]+`. `params` is opaque — it is never parsed,
and it is the reason you cannot reconstruct a key name from a user ID alone.

Each user has **1 to 3 variants**, chosen deterministically from the seed (see below).

## The index (Redis sets)

```
KEY      entityIndex::demo::activeSubscription::u_0001234
MEMBERS  the full cache keys currently written for that user
TTL      3600 seconds
```

**A set, not a hash.** The index deliberately stores no timestamps. Invalidation deletes every
recorded name unconditionally — deleting an already-absent key is free, whereas skipping a key
that is still alive because a client clock ran fast is a correctness bug.

**Setting the TTL takes two commands.** `SADD` creates a *persistent* key, and a key with no TTL
counts as *infinite* for a `GT` comparison — so `EXPIRE ... GT` on its own returns 0 forever and
the index never expires. It must be `EXPIRE key ttl NX` (establish) followed by
`EXPIRE key ttl GT` (extend, never shorten), both inside one `MULTI`.

The fixture writer uses `EntityIndex.registerMany()` from the shared package. With a supplied
value, `SET key value EX ttl` is in the same bounded transaction as the three registration
commands. The single-key `register()` method uses the same implementation. All records are
validated before writes; Redis runtime failures are checked but cannot be rolled back.

## The two invalidation paths

### v1 — legacy, O(N) scan

For each user ID, one `KEYS` call over the whole keyspace, then delete the matches:

```
KEYS *::u_0001234::*
```

The `::` on both sides matters. `*u_0001234*` would also match
`entityIndex::demo::activeSubscription::u_0001234` — whose name *ends* at the ID — and it would
match those characters anywhere else in a key, including inside a `params` tail. The demo's v1
path must be a fair representation of the legacy approach, not a broken one.

### v2 — per-entity index, O(k)

```
SMEMBERS entityIndex::demo::activeSubscription::u_0001234
UNLINK   <every member, in batches>
SREM     entityIndex::demo::activeSubscription::u_0001234 <the members we just read>
```

**Order is a correctness feature.** Values first, references second. If the process dies or an
`UNLINK` fails, the index still lists exactly what needs deleting, so the same call retried
finishes the job. Reverse the order and a failed delete has erased its own to-do list.

**`SREM` the observed members — never `DEL` the set.** A reference another writer added while
this was running was not in the list we read, and must survive.

## Deterministic seeding

No data files. A seeded PRNG (`SEED_VALUE`, default `1`) produces the same fixture every run, so
the eviction batch always targets users that exist.

```
userId       u_ + zeroPad(i, 7)              for i in 0 .. userCount-1
variants     1 + (hash(i) % 3)
planId       one of pro-monthly, pro-yearly, team-monthly, gen-ai-100k
```

`SEED_KEYS` (default **2,000,000**) is the number of *cache records*, not users. User count is
derived so the totals land near it. Set `SEED_KEYS=10000000` for the full ten-million run.

## Memory and eviction

Measured on a comparable fixture: **~350 MB per million cache records** including indexes, so
2M ≈ 700 MB and 10M ≈ 3.3 GB.

Redis MUST run with `--maxmemory-policy noeviction`. If Redis silently evicts fixture keys
mid-run, the scan gets faster and the demo quietly starts lying.
