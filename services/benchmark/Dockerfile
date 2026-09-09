# Multi-stage. Build stage compiles packages/cache and this service with the full toolchain;
# the runtime stage carries production dependencies and compiled JS only.
# Build context is the repo root (npm workspaces) — see docker-compose.yml.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/cache packages/cache
COPY services/benchmark services/benchmark
COPY services/test-api/package.json services/test-api/package.json
COPY services/webhook/package.json services/webhook/package.json
RUN npm ci
RUN npm run build --workspace @redis-hash-index/benchmark
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/cache/package.json ./packages/cache/package.json
COPY --from=build --chown=node:node /app/packages/cache/dist ./packages/cache/dist
COPY --from=build --chown=node:node /app/services/benchmark/package.json ./services/benchmark/package.json
COPY --from=build --chown=node:node /app/services/benchmark/dist ./services/benchmark/dist
USER node
EXPOSE 3000
CMD ["node", "services/benchmark/dist/index.js"]
