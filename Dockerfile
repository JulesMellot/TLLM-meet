# syntax=docker/dockerfile:1.6

# ---------- Dependencies ----------
# Only this stage has the compilers. mediasoup downloads its ready-made worker (the mediasoup project
# builds it for Linux, checked against this image before use); the compilers are there for the case
# where no such binary exists for this machine, and mediasoup then builds it itself.
FROM node:24-slim AS deps

WORKDIR /src

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# --ignore-scripts skips the root postinstall: it rebuilds public/sfu/MediasoupClient.js, which is
# already in the repository. "npm rebuild mediasoup" then runs mediasoup's own install (its worker).
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts \
    && npm rebuild mediasoup \
    && rm -rf node_modules/mediasoup/worker/prebuild

# ---------- Runtime ----------
FROM node:24-slim

WORKDIR /src

ENV NODE_ENV=production

# Dependencies remain root-owned and readable; application files are owned by node.
COPY --from=deps /src/node_modules ./node_modules
COPY package*.json ./
COPY --chown=node:node app ./app
COPY --chown=node:node public ./public

# Copy config template → config
COPY --chown=node:node app/src/config.template.js app/src/config.js

# TLLM*meet: date polls are written to /src/data (mount a volume there to keep them)
RUN mkdir -p /src/data && chown node:node /src/data
ENV DATA_DIR=/src/data

# Run as the non-root "node" user (uid/gid 1000) shipped with the base image
USER node

# Health check: the server answers and its media workers run (see /healthz in Server.js)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.SERVER_LISTEN_PORT || 3010) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Default command: node itself, so SIGTERM reaches the graceful shutdown (npm would stand in between)
CMD ["node", "app/src/Server.js"]
