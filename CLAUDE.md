# Ralph Agent Instructions

You are an autonomous coding agent working on a software project.

## Your Task

1. Read the PRD at `prd.json` (in the same directory as this file)
2. Read the progress log at `progress.txt` (check Codebase Patterns section first)
3. Check you're on the correct branch from PRD `branchName`. If not, check it out or create from main.
4. Pick the **highest priority** user story where `passes: false`
5. Implement that single user story
6. Run quality checks (e.g., typecheck, lint, test - use whatever your project requires)
7. Update CLAUDE.md files if you discover reusable patterns (see below)
8. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`
9. Update the PRD to set `passes: true` for the completed story
10. Append your progress to `progress.txt`

## Progress Report Format

APPEND to progress.txt (never replace, always append):
```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g., "this codebase uses X for Y")
  - Gotchas encountered (e.g., "don't forget to update Z when changing W")
  - Useful context (e.g., "the evaluation panel is in component X")
---
```

The learnings section is critical - it helps future iterations avoid repeating mistakes and understand the codebase better.

## Consolidate Patterns

If you discover a **reusable pattern** that future iterations should know, add it to the `## Codebase Patterns` section at the TOP of progress.txt (create it if it doesn't exist). This section should consolidate the most important learnings:

```
## Codebase Patterns
- Example: Use `sql<number>` template for aggregations
- Example: Always use `IF NOT EXISTS` for migrations
- Example: Export types from actions.ts for UI components
```

Only add patterns that are **general and reusable**, not story-specific details.

## Update CLAUDE.md Files

Before committing, check if any edited files have learnings worth preserving in nearby CLAUDE.md files:

1. **Identify directories with edited files** - Look at which directories you modified
2. **Check for existing CLAUDE.md** - Look for CLAUDE.md in those directories or parent directories
3. **Add valuable learnings** - If you discovered something future developers/agents should know:
   - API patterns or conventions specific to that module
   - Gotchas or non-obvious requirements
   - Dependencies between files
   - Testing approaches for that area
   - Configuration or environment requirements

**Examples of good CLAUDE.md additions:**
- "When modifying X, also update Y to keep them in sync"
- "This module uses pattern Z for all API calls"
- "Tests require the dev server running on PORT 3000"
- "Field names must match the template exactly"

**Do NOT add:**
- Story-specific implementation details
- Temporary debugging notes
- Information already in progress.txt

Only update CLAUDE.md if you have **genuinely reusable knowledge** that would help future work in that directory.

## Quality Requirements

- ALL commits must pass your project's quality checks (typecheck, lint, test)
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns

## Browser Testing (If Available)

For any story that changes UI, verify it works in the browser if you have browser testing tools configured (e.g., via MCP):

1. Navigate to the relevant page
2. Verify the UI changes work as expected
3. Take a screenshot if helpful for the progress log

If no browser tools are available, note in your progress report that manual browser verification is needed.

## Stop Condition

After completing a user story, check if ALL stories have `passes: true`.

If ALL stories are complete and passing, reply with:
<promise>COMPLETE</promise>

If there are still stories with `passes: false`, end your response normally (another iteration will pick up the next story).

## Important

- Work on ONE story per iteration
- Commit frequently
- Keep CI green
- Read the Codebase Patterns section in progress.txt before starting


---

# This Project — redis-hash-index

A live demo comparing two ways to invalidate a Redis cache: an O(N) keyspace scan versus a
per-entity index. Three slim Express services and one Redis, in Docker.

## Read these before writing code

- `tasks/US-XXX.md` — the full specification behind the story you are implementing
- `docs/REDIS-SCHEMA.md` — key formats and the two invalidation paths. **A contract, not a suggestion.**
- `docs/API.md` — exact endpoint shapes
- `docs/ARCHITECTURE.md` — why the services are split the way they are
- `docs/BENCHMARK-BASELINE.md` — the numbers this demo should reproduce

## Stack

TypeScript, Node 22, Express, ioredis, Docker Compose, npm workspaces. Strict tsconfig.
Keep it slim: no ORM, no frontend framework, no state manager. Every dependency must earn its
place in a demo about one Redis command.

## Commands

```bash
make up          # build, wait for health, then seed the fixture (live progress)
make down        # down -v
make typecheck   # tsc --noEmit across workspaces
make test        # tests
make seed        # (re)seed the fixture; run by `make up`, FORCE=1 to reseed
make verify      # full end-to-end check (US-008)
```

## The four traps in this codebase

1. **`EXPIRE ... GT` alone never fires on a new key.** `SADD` creates a persistent key, and a key
   with no TTL counts as infinite for the `GT` comparison. It must be `NX` to establish, then `GT`
   to extend, inside one `MULTI`.
2. **Invalidation order is a correctness feature.** `SMEMBERS` → `UNLINK` values → `SREM` observed
   members. Values before references, so a failed run can be retried. Never `DEL` the index set.
3. **No timestamps in the delete path.** Delete every recorded member unconditionally. Skipping a
   key because a client clock said it had expired is how you serve stale entitlements.
4. **The v1 `KEYS` pattern is `*::<userId>::*`.** Both delimiters. Without them it also matches the
   index key and anything with those characters in a `params` tail.

## Verification discipline

Do not set `passes: true` on a story whose self-check block you have not actually executed. Run the
commands, read the output, and if something failed leave the story open and write why in
`progress.txt`. An unverified pass poisons every later iteration, because the next one builds on
the assumption that this one worked.
