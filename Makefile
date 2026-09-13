.PHONY: up down logs typecheck test seed reset verify packages

# Bring up the stack, wait for every container to report healthy, then seed the fixture.
# Seeding is a no-op if the fixture is already present — `make reset` first, or `make seed FORCE=1`,
# to reseed. `SEED_KEYS=… make up` still controls the fixture size.
up: node_modules
	docker compose up -d --build
	@echo "waiting for containers to become healthy..."
	@timeout 90 sh -c 'until [ -z "$$(docker compose ps -q)" ] || ! docker compose ps -q | xargs -r docker inspect --format "{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}" | grep -vE "(healthy|no-healthcheck)$$"; do sleep 2; done'
	@docker compose ps
	@$(MAKE) --no-print-directory seed

down:
	docker compose down -v

logs:
	docker compose logs -f --tail=100

typecheck: packages
	npm run typecheck --workspaces --if-present

test: packages
	docker compose up -d redis
	@timeout 30 sh -c 'until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 1; done'
	npm run test --workspaces --if-present

# Seed the deterministic fixture and stream live progress. Needs the stack up (`make up` runs it).
seed:
	@node scripts/seed.mjs

reset:
	curl -fsS -XPOST localhost:3000/api/seed/reset || true

verify:
	SEED_KEYS=$${SEED_KEYS:-50000} node scripts/verify.mjs

node_modules: package.json
	npm install
	@touch node_modules

# Services typecheck and run against the shared packages' compiled dist/. Build them in dependency
# order every time: npm runs workspace `prepare` scripts in parallel, so fixture cannot rely on one.
packages: node_modules
	npm run build --workspace @redis-hash-index/cache --workspace @redis-hash-index/fixture
