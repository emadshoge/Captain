# Image for the Next.js apps (standalone server).
#   APP=rider-web (port 3001) | APP=staff-web (port 3002)
# NEXT_PUBLIC_API_URL is compiled into the browser bundle, so images are built
# per environment:
#   docker build -f docker/web.Dockerfile --build-arg APP=rider-web \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.staging.example -t captain-rider-web .
ARG NODE_IMAGE=node:22.22.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG APP
ARG NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_STANDALONE=1 \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter "@captain/${APP}" build

FROM ${NODE_IMAGE}
ARG APP
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    APP_DIR=apps/${APP}
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
USER node
CMD ["sh", "-c", "exec node \"$APP_DIR/server.js\""]
