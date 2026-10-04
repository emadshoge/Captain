# Image for the Node services built as self-contained esbuild bundles:
#   APP=api          → node dist/server.js (also dist/worker.js, dist/cli/*.js)
#   APP=iot-gateway  → node dist/main.js
# Build from the repository root:
#   docker build -f docker/node-service.Dockerfile --build-arg APP=api -t captain-api .
ARG NODE_IMAGE=node:22.22.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG APP
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter "@captain/${APP}" build

FROM ${NODE_IMAGE}
ARG APP
ENV NODE_ENV=production \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/${APP}/dist ./dist
USER node
# The command is chosen per process type by the platform:
#   api: node dist/server.js | worker: node dist/worker.js | migrations: node dist/cli/migrate.js
#   iot-gateway: node dist/main.js
CMD ["node", "dist/server.js"]
