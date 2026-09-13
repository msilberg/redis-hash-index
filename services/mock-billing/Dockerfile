# Multi-stage. Build stage compiles packages/fixture and this service with the full toolchain;
# the runtime stage carries production dependencies and compiled JS only.
# Build context is the repo root (npm workspaces) — see docker-compose.yml.
#
# mock-billing needs no cache package at runtime. packages/cache is copied into the BUILD stage only
# because `npm ci` runs its `prepare` for every workspace in the lockfile.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/cache packages/cache
COPY packages/fixture packages/fixture
COPY services/mock-billing services/mock-billing
COPY services/test-api/package.json services/test-api/package.json
COPY services/webhook/package.json services/webhook/package.json
COPY services/benchmark/package.json services/benchmark/package.json
RUN npm ci
RUN npm run build --workspace @redis-hash-index/fixture
RUN npm run build --workspace @redis-hash-index/mock-billing
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/fixture/package.json ./packages/fixture/package.json
COPY --from=build --chown=node:node /app/packages/fixture/dist ./packages/fixture/dist
COPY --from=build --chown=node:node /app/services/mock-billing/package.json ./services/mock-billing/package.json
COPY --from=build --chown=node:node /app/services/mock-billing/dist ./services/mock-billing/dist
USER node
EXPOSE 3003
CMD ["node", "services/mock-billing/dist/index.js"]
