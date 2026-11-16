# tv-next-scheduler in Docker.
#
# The app lives in /app; everything it writes (settings, library, channels,
# playouts, guide, and the ErsatzTV next + ffmpeg it downloads) lives in /config,
# so mount a volume there. See docs/DOCKER.md and docker-compose.example.yml.
#
#   docker build -t tv-next-scheduler .

ARG NODE_VERSION=24

# ---- build: compile the server and the web UI ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm --prefix web run build

# ---- deps: production packages only (resvg's native build for this platform) ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim
# HWACCEL=true adds the VA-API drivers (Intel/AMD GPUs through /dev/dri) on x64.
ARG HWACCEL=true
ARG TARGETARCH
RUN set -eux; \
    sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tini tar xz-utils tzdata fonts-dejavu-core fontconfig; \
    if [ "$HWACCEL" = "true" ]; then \
      apt-get install -y --no-install-recommends libva2 libva-drm2 vainfo mesa-va-drivers; \
      if [ "$TARGETARCH" = "amd64" ] || [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        apt-get install -y --no-install-recommends intel-media-va-driver-non-free i965-va-driver; \
      fi; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/web/dist ./web/dist
COPY examples ./examples
COPY docker/entrypoint.sh /usr/local/bin/tvns-entrypoint
# The server keeps its data in folders beside the app (data/, channels/, runtime/,
# bin/, playouts/); point each at /config so one volume holds all of it.
RUN set -eux; \
    chmod 755 /usr/local/bin/tvns-entrypoint; \
    for d in data channels runtime bin playouts; do ln -s "/config/$d" "/app/$d"; done; \
    mkdir -p /config; chmod 777 /config

ENV NODE_ENV=production \
    PORT=8730 \
    TVNS_DOCKER=1 \
    TZ=Etc/UTC \
    # with an NVIDIA GPU passed through, also mount its encoder/decoder libraries
    # (the default is compute only, so NVENC fails to load libnvidia-encode)
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
# 8730 web UI + API, 8409 ErsatzTV next (M3U, XMLTV, streams), 5004 HDHomeRun tuner
EXPOSE 8730 8409 5004
VOLUME ["/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8730)+'/api/scheduler').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tvns-entrypoint"]
CMD ["node", "/app/dist/server/main.js"]
