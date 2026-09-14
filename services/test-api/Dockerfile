# Multi-stage. Build stage compiles packages/cache, packages/fixture and this service with the full toolchain;
# the runtime stage carries production dependencies and compiled JS only.
# Build context is the repo root (npm workspaces) — see docker-compose.yml.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/cache packages/cache
COPY packages/fixture packages/fixture
COPY services/test-api services/test-api
COPY services/webhook/package.json services/webhook/package.json
COPY services/benchmark/package.json services/benchmark/package.json
COPY services/mock-billing/package.json services/mock-billing/package.json
RUN npm ci
# packages/fixture has no `prepare`: npm runs workspace prepares in parallel and it needs cache's dist.
RUN npm run build --workspace @redis-hash-index/fixture
RUN npm run build --workspace @redis-hash-index/test-api
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/cache/package.json ./packages/cache/package.json
COPY --from=build --chown=node:node /app/packages/cache/dist ./packages/cache/dist
COPY --from=build --chown=node:node /app/packages/fixture/package.json ./packages/fixture/package.json
COPY --from=build --chown=node:node /app/packages/fixture/dist ./packages/fixture/dist
COPY --from=build --chown=node:node /app/services/test-api/package.json ./services/test-api/package.json
COPY --from=build --chown=node:node /app/services/test-api/dist ./services/test-api/dist
USER node
EXPOSE 3001
CMD ["node", "services/test-api/dist/index.js"]
