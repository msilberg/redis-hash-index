.PHONY: up down logs typecheck test seed reset verify

# Bring up the stack and wait for every container to report healthy.
up: node_modules
	docker compose up -d --build
	@echo "waiting for containers to become healthy..."
	@timeout 90 sh -c 'until [ -z "$$(docker compose ps -q)" ] || ! docker compose ps -q | xargs -r docker inspect --format "{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}" | grep -vE "(healthy|no-healthcheck)$$"; do sleep 2; done'
	@docker compose ps

down:
	docker compose down -v

logs:
	docker compose logs -f --tail=100

typecheck: node_modules
	npm run typecheck --workspaces --if-present

test: node_modules
	docker compose up -d redis
	@timeout 30 sh -c 'until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 1; done'
	npm run test --workspaces --if-present

seed:
	curl -fsS -XPOST localhost:3000/api/seed || true

reset:
	curl -fsS -XPOST localhost:3000/api/seed/reset || true

verify:
	SEED_KEYS=$${SEED_KEYS:-50000} node scripts/verify.mjs

node_modules: package.json
	npm install
	@touch node_modules
