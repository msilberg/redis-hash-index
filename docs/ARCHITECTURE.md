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
