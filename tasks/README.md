# Task specifications

`prd.json` is what the Ralph loop actually reads: it holds the ordered user stories, their
acceptance criteria and the `passes` flag each iteration flips. **Do not rename or restructure it** —
`ralph.sh` parses `branchName` out of it with `jq`.

These `tasks/US-*.md` files are the long form behind each story: the reasoning, the exact
contracts, the traps, and a self-check block so an iteration can tell whether it actually
succeeded rather than assuming it did.

| Story | What it delivers |
|---|---|
| [US-001](US-001.md) | Compose skeleton, Redis, workspaces, Makefile |
| [US-002](US-002.md) | `packages/cache` — the shared entity index |
| [US-003](US-003.md) | test-api — the innocent bystander |
| [US-004](US-004.md) | webhook — both invalidation paths |
| [US-005](US-005.md) | benchmark — deterministic seeder |
| [US-006](US-006.md) | benchmark — run driver |
| [US-007](US-007.md) | benchmark — live UI |
| [US-008](US-008.md) | End-to-end verification and README |

## Working rules for every story

1. **One story per iteration.** Do not start the next one because you have context left.
2. **Never mark `passes: true` on a story whose self-check you have not actually run.** Run the
   commands, read the output. An unverified pass poisons every later iteration.
3. **If a story is blocked**, leave `passes: false`, write what blocked you in `notes` and in
   `progress.txt`, and stop. A later iteration with fresh context may see it immediately.
4. **Keep services slim.** Express, ioredis, and as little else as possible. No ORM, no framework,
   no state manager. Every dependency has to earn its place in a demo about one Redis command.
