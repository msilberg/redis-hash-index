
# redis-hash-index

A live demo of two ways to invalidate a Redis cache, measured under load:

- **v1 — the legacy path.** For each user, scan the whole keyspace with `KEYS` to discover which
  keys belong to them, then delete the matches. O(N) per user.
- **v2 — a per-entity index.** Keep one small Redis set per user listing its cache keys. Read one
  set, delete what it lists. O(k) per user, independent of keyspace size.

The interesting part is not how long each takes. It is what happens to **everybody else** while it
runs, because Redis executes commands on a single thread.

> **Status: scaffolded, not yet built.** This repository currently contains the specification, the
> task breakdown and the [Ralph](https://github.com/snarktank/ralph) harness that will build it.
> See [How this is being built](#how-this-is-being-built).

---

## What it looks like

Three Express services and one Redis, each in its own container:

```
   browser ──► benchmark :3000 ──1 req/sec──► test-api :3001 ──read──┐
                    │                                               ▼
                    └──────batch of user IDs──► webhook :3002 ──► redis :6379
                                                          delete
```

`test-api` is the innocent bystander. It has its own Redis connection and never scans. When the
webhook starts scanning on v1, `test-api` gets slower — not because it did anything, but because
it is queued behind a command that holds the server. That is the whole demonstration, and it only
shows if the victim and the perpetrator are genuinely separate processes.

## Quick start

Requires Docker, `make`, and `jq`.

```bash
make up                 # brings up redis + the three services
make seed               # populates the fixture (default 2M records, ~1 min, ~700 MB)
open http://localhost:3000
```

Then press one of the two buttons and watch the graph.

For the full ten-million-record run:

```bash
SEED_KEYS=10000000 make up && make seed     # ~3.3 GB, several minutes
```

## What each run should look like

**Measure hashed index eviction (v2).** The latency line does not move. A thousand users are
invalidated in well under a second. The graph is boring, which is the argument.

**Measure legacy (KEYS) eviction (v1).** The latency line steps from about a millisecond to
seconds on the very first scan, and stays there — one step per user in the batch.

**The legacy run is not meant to finish.** One thousand users, one full keyspace scan each, is
roughly 35 minutes at 2M records and about three hours at 10M. Watch it for twenty seconds and
press **Stop**. Both eviction endpoints return `202` immediately and run in the background
precisely so that a demo nobody can wait for does not also hang the browser.

## Reference numbers

Measured on a 2-core Xeon, Redis 7.0.15, loopback, two counterbalanced trials per row:

| cached values | total keys | `KEYS` median | index median | competing `GET` during `KEYS` |
|---|---|---|---|---|
| 1,000,002 | 1,166,669 | 987 ms | 0.107 ms | **987 ms** |
| 2,000,004 | 2,333,338 | 2,309 ms | 0.095 ms | **2,291 ms** |
| 8,570,004 | 9,998,338 | 10,957 ms | 0.095 ms | **10,937 ms** |

The last column is the point: an unrelated client doing nothing but `GET` waits out the entire
scan. Full method and sample counts in [docs/BENCHMARK-BASELINE.md](docs/BENCHMARK-BASELINE.md).

## Caveats, stated plainly

- One sample per second from one client is enough to show a step change of four orders of
  magnitude. It is not a latency distribution.
- The scanned keyspace includes the index keys, so v1 traverses slightly more than a cache with no
  index would. Fair same-fixture comparison, not identical to a greenfield legacy system.
- Single Redis instance over loopback, no replication or clustering. Multi-key `UNLINK` and the
  pipelines here would need slot-aware routing on Redis Cluster.
- Redis runs with `--maxmemory-policy noeviction`. If it evicted the fixture, the keyspace would
  shrink, the scan would speed up, and the benchmark would quietly start lying.

## Documentation

| Document | What's in it |
|---|---|
| [docs/REDIS-SCHEMA.md](docs/REDIS-SCHEMA.md) | Key formats, both invalidation paths, deterministic seeding |
| [docs/API.md](docs/API.md) | Endpoint contracts for all three services |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why the services are split this way |
| [docs/BENCHMARK-BASELINE.md](docs/BENCHMARK-BASELINE.md) | Reference measurements and method |
| [tasks/](tasks/) | The eight build stories, in full |

## How this is being built

With the [Ralph](https://github.com/snarktank/ralph) technique: a bash loop that starts a fresh
agent with clean context on each iteration, pointed at a PRD, working one story at a time and
committing as it goes.

```bash
./ralph.sh --tool claude 20
```

Each iteration reads `prd.json`, picks the highest-priority story where `passes: false`, reads the
matching `tasks/US-XXX.md` for the full specification, implements it, runs the self-check block at
the bottom of that file, commits, sets `passes: true`, and appends what it learned to
`progress.txt`. The loop exits when every story passes.

| File | Role |
|---|---|
| `ralph.sh` | The loop. Requires `jq`. |
| `CLAUDE.md` | Instructions handed to each Claude Code iteration, plus this project's context |
| `prompt.md` | The same, for Amp |
| `prd.json` | The eight stories, their acceptance criteria, and the `passes` flags |
| `tasks/US-*.md` | Full specification and self-check for each story |
| `progress.txt` | Append-only log, with a Codebase Patterns section iterations read first |
| `skills/` | The `prd` and `ralph` skills from the upstream project |

Ralph tooling is copied from [snarktank/ralph](https://github.com/snarktank/ralph) (MIT) — its
licence is preserved at [vendor/LICENSE.ralph-MIT](vendor/LICENSE.ralph-MIT).

## Background

This demo accompanies an article on cache invalidation, secondary indexes, and why
`KEYS` and `FLUSHALL` are the same mistake in different clothes.

## Licence

GPL-3.0. See [LICENSE](LICENSE).
