# Baseline measurements

Reference numbers taken on a 2-core Xeon @ 2.80GHz, Redis 7.0.15, Node 22, ioredis 6, loopback
TCP, single instance, no replication. Two trials per row with alternating order, warm-up before
each mode, minimum sample counts enforced.

The fixture: six cache records per entity plus one index key per entity.

| cached values | total keys | `KEYS` median (n) | index median / p99 (n) | competing `GET` during `KEYS` |
|---|---|---|---|---|
| 100,002 | 116,669 | 85 ms (47) | 0.096 / 0.270 ms (33,999) | 85 ms |
| 500,004 | 583,338 | 525 ms (10) | 0.098 / 0.215 ms (33,260) | 523 ms |
| 1,000,002 | 1,166,669 | 987 ms (10) | 0.107 / 0.304 ms (29,431) | 987 ms |
| 2,000,004 | 2,333,338 | 2,309 ms (10) | 0.095 / 0.226 ms (34,223) | 2,291 ms |
| 8,570,004 | 9,998,338 | 10,957 ms (10) | 0.095 / 0.261 ms (35,437) | 10,937 ms |

`KEYS` sample ranges: 83–116, 514–550, 951–1,062, 2,224–2,588 and 10,844–12,091 ms.

## What this demo should reproduce

At the default `SEED_KEYS=2000000` (this repo's fixture is 1–3 variants per user, not 6, so the
key count differs slightly), expect:

- **v1**: `test-api` latency stepping to roughly **2 seconds** per scan and staying there.
- **v2**: `test-api` latency unchanged, around **1 ms** including HTTP.
- A 1,000-user v1 batch would take roughly **35 minutes** at 2M keys and about **3 hours** at 10M.
  It is not meant to finish. Watch the graph for twenty seconds and press Stop.

If your numbers are far off these, check `maxmemory-policy` — a Redis that is evicting the fixture
will scan a smaller keyspace and look deceptively fast.
