# redis-hash-index

Two ways to invalidate a Redis cache, measured under load, against one Redis.

- **v1 — the legacy path.** For each user, scan the whole keyspace with `KEYS *::<userId>::*`
  to find their cache keys, then delete the matches. O(N) per user, N = every key in Redis.
- **v2 — a per-entity index.** Keep one small Redis set per user listing its cache keys
  (`entityIndex::demo::activeSubscription::<userId>`). Read the set, delete what it lists,
  `SREM` the names you read. O(k) per user, independent of keyspace size.

The interesting part is not how long each takes. It is what happens to **everybody else** while
it runs, because Redis executes commands on a single thread. `KEYS` over a few million keys holds
that thread for seconds, and every other client — including ones doing nothing but a single `GET` —
waits behind it.

---

## 1. What this shows

Three Express services and one Redis, each in its own container:

```
                    ┌──────────────┐
   browser ────────►│  benchmark   │ :3000   UI + WebSocket + seeder + run driver
                    └──────┬───────┘
                           │  1 poll/sec             batch of 1000 user IDs
                    ┌──────▼───────┐            ┌──────────────┐
                    │   test-api   │ :3001      │   webhook    │ :3002
                    └──────┬───────┘            └──────┬───────┘
                           │ read (SMEMBERS+MGET)      │ delete (v1 KEYS · v2 index)
                           └─────────┬─────────────────┘
                                     ▼
                              ┌─────────────┐
                              │    redis    │ :6379   single instance, noeviction
                              └─────────────┘
```

`test-api` is the innocent bystander. It has its **own** Redis connection and never scans. When
the webhook starts a v1 scan, `test-api` gets slower — not because it did anything, but because it
is queued behind a command that holds the server. That is the whole demonstration, and it only
shows because the victim and the perpetrator are genuinely separate processes.

## 2. Quick start

Requires Docker and `make`. (`node` on the host is used only by `make up`'s seed step and `make verify`.)

```bash
make up                 # build, wait for health, seed the fixture (default 2M records, ~1 min, ~700 MB)
open http://localhost:3000
```

`make up` seeds automatically and streams live progress; it skips seeding if the fixture is already
there. Re-seed a running stack with `make seed` (or `make seed FORCE=1` to overwrite an existing
fixture).

Then press one of the two buttons and watch the chart. Press **Stop** when you have seen enough.

## 3. What each run should look like

The y axis is **latencyMs on a log scale** — the two modes differ by about four orders of
magnitude and a linear axis makes v2 invisible. A shaded marker shows the moment the eviction
batch was dispatched.

**Measure hashed index eviction (v2)** — `docs/run-index.json`. The latency line does not move.
A thousand users are invalidated in well under a second. The chart is boring, which is the
argument.

**Measure legacy (KEYS) eviction (v1)** — `docs/run-legacy.json`. At the full 2M+ fixture the
latency line steps from about a millisecond to ~2 seconds on the very first scan and stays there,
one step per user. The webhook `processed` counter crawls (~20 users/sec).

> **About the committed samples.** This repo was built in an environment with no browser tooling,
> so `docs/run-legacy.json` and `docs/run-index.json` are the captured WebSocket frames of a run
> rather than screenshots. They were taken at `SEED_KEYS=50000` — small enough that a `KEYS` scan
> over ~75k keys is still sub-millisecond, so the v1 sample shows the **`processed` crawl** clearly
> but not the latency spike. The four-orders-of-magnitude step needs the 2M+ fixture; the
> [reference numbers](#5-why-the-legacy-run-does-not-finish) below are from that scale. Regenerate
> either file with `node scripts/capture-run.mjs <v1|v2> <seconds> <outfile>` against a running,
> seeded stack.

## 4. Costs

Roughly **350 MB per million cache records** including indexes:

| `SEED_KEYS` | memory | seed time | notes |
|---|---|---|---|
| 50,000 | ~40 MB | ~1 s | what `make verify` uses |
| 2,000,000 (default) | ~700 MB | ~1 min | the demo fixture |
| 10,000,000 | ~3.3 GB | several minutes | the full run |

```bash
SEED_KEYS=10000000 make up
```

The fixture is deterministic from `SEED_VALUE` (default `1`): the same seed produces byte-identical
keys and values, and nothing large lives in git.

## 5. Why the legacy run does not finish

One thousand users, one full keyspace scan each, is roughly **35 minutes at 2M records** and about
**3 hours at 10M**. A 1000-user v1 batch is **not meant to finish** — watch the graph for twenty
seconds, then press **Stop**. Both eviction endpoints return `202` immediately and run the work in
the background precisely so a demo nobody can wait for does not also hang the browser.

Reference numbers (2-core Xeon, Redis 7.0.15, loopback, two counterbalanced trials per row — full
method in [docs/BENCHMARK-BASELINE.md](docs/BENCHMARK-BASELINE.md)):

| cached values | total keys | `KEYS` median | index median | competing `GET` during `KEYS` |
|---|---|---|---|---|
| 1,000,002 | 1,166,669 | 987 ms | 0.107 ms | **987 ms** |
| 2,000,004 | 2,333,338 | 2,309 ms | 0.095 ms | **2,291 ms** |
| 8,570,004 | 9,998,338 | 10,957 ms | 0.095 ms | **10,937 ms** |

The last column is the point: an unrelated client doing nothing but `GET` waits out the entire
scan.

## 6. Caveats, stated plainly

- One sample per second from one client is enough to show a step change of four orders of
  magnitude. It is **not** a latency distribution.
- The scanned keyspace includes the index keys, so v1 traverses slightly more than a cache with no
  index would. A fair same-fixture comparison, not identical to a greenfield legacy system.
- Loopback and a single Redis instance, no replication or clustering. The multi-key `UNLINK` and
  the pipelines here would need slot-aware routing on Redis Cluster.
- Redis runs with `--maxmemory-policy noeviction`. If it evicted the fixture the keyspace would
  shrink, the scan would speed up, and the benchmark would quietly start lying.

## 7. Documentation

| Document | What's in it |
|---|---|
| [docs/REDIS-SCHEMA.md](docs/REDIS-SCHEMA.md) | Key formats and both invalidation paths — the contract every service shares |
| [docs/API.md](docs/API.md) | Endpoint contracts for all three services |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why the services are split this way |
| [docs/BENCHMARK-BASELINE.md](docs/BENCHMARK-BASELINE.md) | Reference measurements and method |
| [docs/run-index.json](docs/run-index.json) · [docs/run-legacy.json](docs/run-legacy.json) | Captured WebSocket frames from each run |
| [tasks/](tasks/) | The eight build stories, in full |

## 8. Verify it yourself

```bash
make verify
```

Brings the stack up, seeds `SEED_KEYS=50000`, starts a **v2** run end to end, waits for the
webhook job to reach `done`, then asserts:

- every cache key **and** index key for the 1000 batch users is gone,
- an untouched control user still has its cache,
- `DBSIZE` dropped by exactly the number of keys those users owned,

and `docker compose down -v` afterwards. It exits non-zero on any failure.

```bash
make typecheck && make test        # tsc --noEmit and the test suites, all against a real Redis
```

## How this was built

With the [Ralph](https://github.com/snarktank/ralph) technique: a bash loop that starts a fresh
agent with clean context on each iteration, pointed at `prd.json`, working one story at a time and
committing as it goes.

```bash
./ralph.sh --tool claude 20
```

Each iteration reads `prd.json`, picks the highest-priority story where `passes: false`, reads the
matching `tasks/US-XXX.md` for the full specification, implements it, runs that file's self-check
block, commits, sets `passes: true`, and appends what it learned to `progress.txt`. The loop exits
when every story passes.

| File | Role |
|---|---|
| `ralph.sh` | The loop. Requires `jq`. |
| `CLAUDE.md` | Instructions handed to each iteration, plus this project's context |
| `prd.json` | The eight stories, their acceptance criteria, and the `passes` flags |
| `tasks/US-*.md` | Full specification and self-check for each story |
| `progress.txt` | Append-only log, with a Codebase Patterns section iterations read first |

Ralph tooling is copied from [snarktank/ralph](https://github.com/snarktank/ralph) (MIT) — its
licence is preserved at [vendor/LICENSE.ralph-MIT](vendor/LICENSE.ralph-MIT).

## Background

This demo accompanies an article on cache invalidation, secondary indexes, and why `KEYS` and
`FLUSHALL` are the same mistake in different clothes.

## Licence

GPL-3.0. See [LICENSE](LICENSE).
