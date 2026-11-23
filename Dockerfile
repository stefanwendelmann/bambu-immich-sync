# Reproducible runtime dependencies, then official Immich CLI image.
FROM node:22-alpine AS dependencies
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ghcr.io/immich-app/immich-cli:latest
WORKDIR /app
COPY --from=dependencies /build/node_modules /app/node_modules
COPY src/ /app/src/
RUN mkdir -p /data /app && chmod 0770 /data \
    && ln -s /usr/src/app/packages/cli/bin/immich /usr/local/bin/immich
ENV DATA_DIR=/data \
    SYNC_INTERVAL=300 \
    BAMBU_REMOTE_PATH=/timelapse \
    NODE_ENV=production
USER 0
ENTRYPOINT ["node", "/app/src/sync.mjs"]
